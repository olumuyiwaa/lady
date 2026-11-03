const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { audit } = require('../../utils/audit');
const { oneLine, referenceFromId, sendTracked } = require('../../lib/contactMail');
const notifications = require('../notifications/notifications.service');

// A visitor can submit the public contact form at most this many times per
// address, per business, per day (on top of the per-IP limiter and captcha).
const WEBSITE_TICKETS_PER_EMAIL_PER_DAY = 5;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * customerId / bookingId arrive from the client. They must belong to THIS
 * business: without the check a ticket could point at another tenant's record,
 * and prefilling contact details from it would leak that tenant's customer data.
 * Returns the customer (if any) so callers can prefill contact fields.
 */
async function resolveOwnedRefs(businessId, { customerId, bookingId }) {
  let customer = null;
  if (customerId) {
    customer = await prisma.customer.findFirst({
      where: { id: customerId, businessId },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true },
    });
    if (!customer) throw httpError(422, 'Customer not found');
  }
  if (bookingId) {
    const booking = await prisma.booking.findFirst({ where: { id: bookingId, businessId }, select: { id: true } });
    if (!booking) throw httpError(422, 'Booking not found');
  }
  return customer;
}

// Anonymised customers keep a 'deleted-<id>' placeholder in the phone column.
const usablePhone = (p) => (p && !String(p).startsWith('deleted-') ? p : null);

async function listTickets(businessId, { status, priority, q, page = 1, limit = 20 } = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { businessId };
  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (q) {
    where.OR = [
      { subject: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
      { contactName: { contains: q, mode: 'insensitive' } },
      { contactEmail: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [total, tickets] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
      skip,
      take,
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    }),
  ]);

  return {
    data: tickets,
    pagination: {
      page: Math.max(parseInt(page, 10) || 1, 1),
      limit: take,
      total,
      totalPages: Math.ceil(total / take) || 1,
    },
  };
}

async function getTicket(businessId, id) {
  const ticket = await prisma.supportTicket.findFirst({
    where: { id, businessId },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!ticket) {
    const err = new Error('Ticket not found');
    err.status = 404;
    throw err;
  }
  return ticket;
}

async function createTicket(businessId, actorUserId, body) {
  const customer = await resolveOwnedRefs(businessId, body);
  const fullName = customer ? oneLine(`${customer.firstName || ''} ${customer.lastName || ''}`, 100) : '';
  const ticket = await prisma.supportTicket.create({
    data: {
      businessId,
      subject: body.subject,
      description: body.description,
      priority: body.priority || 'MEDIUM',
      category: body.category || null,
      customerId: body.customerId || null,
      bookingId: body.bookingId || null,
      assignedTo: body.assignedTo || null,
      createdBy: actorUserId,
      // Entered contact details win; otherwise fall back to the linked customer.
      contactName: oneLine(body.contactName, 100) || fullName || null,
      contactEmail: (oneLine(body.contactEmail, 254) || customer?.email || '').toLowerCase() || null,
      contactPhone: oneLine(body.contactPhone, 40) || usablePhone(customer?.phone) || null,
      status: 'OPEN',
    },
  });
  await audit({
    businessId,
    actorUserId,
    action: 'TICKET_CREATED',
    entityType: 'SupportTicket',
    entityId: ticket.id,
    metadata: { subject: ticket.subject, priority: ticket.priority },
  });
  return ticket;
}

async function updateTicket(businessId, id, actorUserId, body) {
  const existing = await prisma.supportTicket.findFirst({ where: { id, businessId } });
  if (!existing) {
    const err = new Error('Ticket not found');
    err.status = 404;
    throw err;
  }

  await resolveOwnedRefs(businessId, { customerId: body.customerId, bookingId: body.bookingId });

  const data = {};
  if (body.subject !== undefined) data.subject = body.subject;
  if (body.description !== undefined) data.description = body.description;
  if (body.status !== undefined) data.status = body.status;
  if (body.priority !== undefined) data.priority = body.priority;
  if (body.category !== undefined) data.category = body.category;
  if (body.assignedTo !== undefined) data.assignedTo = body.assignedTo;
  if (body.customerId !== undefined) data.customerId = body.customerId;
  if (body.bookingId !== undefined) data.bookingId = body.bookingId;
  if (body.contactName !== undefined) data.contactName = oneLine(body.contactName, 100) || null;
  if (body.contactEmail !== undefined) data.contactEmail = oneLine(body.contactEmail, 254).toLowerCase() || null;
  if (body.contactPhone !== undefined) data.contactPhone = oneLine(body.contactPhone, 40) || null;
  if (body.status === 'RESOLVED' || body.status === 'CLOSED') {
    data.resolvedAt = new Date();
  }

  const ticket = await prisma.supportTicket.update({ where: { id }, data });
  await audit({
    businessId,
    actorUserId,
    action: 'TICKET_UPDATED',
    entityType: 'SupportTicket',
    entityId: id,
    metadata: { previousData: existing, newData: data },
  });
  return ticket;
}

async function addMessage(businessId, ticketId, actorUserId, { body, isInternal }) {
  const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId, businessId } });
  if (!ticket) {
    throw httpError(404, 'Ticket not found');
  }

  // A customer-facing reply goes out by email when we have an address. emailedAt
  // is only set when the mail was really handed to a provider, so the dashboard
  // can say "emailed" or "not emailed" truthfully (no provider configured, send
  // failed, or no address on the ticket all leave it null).
  let emailedAt = null;
  if (!isInternal && ticket.contactEmail) {
    const [business, actor] = await Promise.all([
      prisma.business.findUnique({ where: { id: businessId }, select: { name: true, contactEmail: true } }),
      prisma.user.findUnique({ where: { id: actorUserId }, select: { email: true } }),
    ]);
    const ref = referenceFromId(ticket.id);
    const sent = await sendTracked({
      to: ticket.contactEmail,
      subject: `Re: ${ticket.subject} [${ref}]`,
      text: `${body}\n\n--\n${business?.name || ''}\nReference: ${ref}\nYou can reply directly to this email.`,
      // Replies from the customer land in the business's own inbox.
      replyTo: business?.contactEmail || actor?.email,
    });
    if (sent) emailedAt = new Date();
  }

  const message = await prisma.supportTicketMessage.create({
    data: {
      ticketId,
      authorId: actorUserId,
      body,
      isInternal: !!isInternal,
      emailedAt,
    },
  });
  // bump ticket updatedAt + move out of WAITING if staff replied
  await prisma.supportTicket.update({
    where: { id: ticketId },
    data: {
      updatedAt: new Date(),
      ...(ticket.status === 'WAITING_ON_CUSTOMER' && !isInternal
        ? { status: 'IN_PROGRESS' }
        : {}),
    },
  });
  return message;
}

/** Who should hear about a new message from the public site. */
async function staffRecipients(business) {
  if (business.contactEmail) return [business.contactEmail];
  const members = await prisma.businessMember.findMany({
    where: { businessId: business.id, isActive: true, role: { in: ['BUSINESS_OWNER', 'BUSINESS_MANAGER'] } },
    include: { user: { select: { email: true, isActive: true } } },
  });
  return [...new Set(members.filter((m) => m.user?.isActive && m.user.email).map((m) => m.user.email))];
}

/**
 * A message from the public storefront's contact form. Creates a ticket for the
 * business, tells the business (in-app + email) and acknowledges the sender.
 * Everything after the ticket is saved is best-effort: the visitor's message is
 * already stored, so a mail problem must not turn into an error for them.
 *
 * `business` is the full Business row resolved from the URL, never client input.
 */
async function createWebsiteTicket(business, { name, email, phone, message }) {
  const contactEmail = String(email).trim().toLowerCase();
  const contactName = oneLine(name, 100);
  const contactPhone = oneLine(phone, 40) || null;
  const text = String(message).trim();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await prisma.supportTicket.count({
    where: { businessId: business.id, source: 'WEBSITE', contactEmail, createdAt: { gte: since } },
  });
  if (recent >= WEBSITE_TICKETS_PER_EMAIL_PER_DAY) {
    throw httpError(429, 'You have sent several messages today. Please wait for a reply before sending more.');
  }

  const ticket = await prisma.supportTicket.create({
    data: {
      businessId: business.id,
      subject: `Message from ${contactName}`,
      description: text,
      priority: 'MEDIUM',
      category: 'WEBSITE',
      source: 'WEBSITE',
      contactName,
      contactEmail,
      contactPhone,
      status: 'OPEN',
    },
  });
  const reference = referenceFromId(ticket.id);

  try {
    await audit({
      businessId: business.id,
      action: 'TICKET_CREATED',
      entityType: 'SupportTicket',
      entityId: ticket.id,
      metadata: { source: 'WEBSITE', reference },
    });

    await notifications.notifyMembers(
      business.id,
      'SUPPORT_TICKET',
      'New message from your website',
      `${contactName}: ${text.slice(0, 140)}`
    );

    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    const staffText = [
      `${contactName} sent a message through your website.`,
      '',
      `From:      ${contactName} <${contactEmail}>`,
      contactPhone ? `Phone:     ${contactPhone}` : null,
      `Reference: ${reference}`,
      '',
      text,
      '',
      '--',
      'Reply to this email to answer them directly' + (appUrl ? `, or open the ticket: ${appUrl}/support-tickets` : '.'),
    ].filter((l) => l !== null).join('\n');

    for (const to of await staffRecipients(business)) {
      // Reply-To is the visitor, so replying from a mailbox reaches them directly.
      await sendTracked({
        to,
        subject: `New website message from ${contactName} [${reference}]`,
        text: staffText,
        replyTo: contactEmail,
      });
    }

    await sendTracked({
      to: contactEmail,
      subject: `We received your message - ${business.name} [${reference}]`,
      text: [
        `Hi ${contactName},`,
        '',
        `Thanks for contacting ${business.name}. We have your message and will reply by email.`,
        `Your reference is ${reference}.`,
        '',
        'Your message:',
        text,
      ].join('\n'),
      replyTo: business.contactEmail || undefined,
    });
  } catch (err) {
    logger.error('website ticket follow-up failed', { ticketId: ticket.id, error: err.message });
  }

  return { reference };
}

async function deleteTicket(businessId, id, actorUserId) {
  const existing = await prisma.supportTicket.findFirst({ where: { id, businessId } });
  if (!existing) {
    const err = new Error('Ticket not found');
    err.status = 404;
    throw err;
  }
  await prisma.supportTicket.delete({ where: { id } });
  await audit({
    businessId,
    actorUserId,
    action: 'TICKET_DELETED',
    entityType: 'SupportTicket',
    entityId: id,
    metadata: { subject: existing.subject },
  });
}

module.exports = {
  listTickets,
  getTicket,
  createTicket,
  updateTicket,
  addMessage,
  deleteTicket,
  createWebsiteTicket,
};
