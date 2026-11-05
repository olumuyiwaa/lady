/**
 * Complaints raised by a customer from the portal about a specific booking.
 *
 * A complaint is a SupportTicket with kind COMPLAINT, linked to the booking,
 * the customer and the cleaner who did the job. Priority and the resolution
 * deadline come from the category (see lib/ticketSla). A customer can have only
 * one open complaint per booking, and may raise one only for a booking that has
 * started or is over, never for a future visit.
 */
const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { audit } = require('../../utils/audit');
const sla = require('../../lib/ticketSla');
const { oneLine, referenceFromId } = require('../../lib/contactMail');

const MAX_DESCRIPTION = 2000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function createComplaint(businessId, customerId, bookingId, { category, description }) {
  const text = typeof description === 'string' ? description.trim() : '';
  if (text.length < 10) throw httpError(422, 'Please describe what went wrong (at least 10 characters)');
  if (text.length > MAX_DESCRIPTION) throw httpError(422, `Description is too long (max ${MAX_DESCRIPTION} characters)`);
  const cat = String(category || 'OTHER').toUpperCase();
  if (!sla.COMPLAINT_CATEGORIES.includes(cat)) throw httpError(422, 'Unknown complaint category');

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId, customerId },
    include: {
      customer: true,
      service: true,
      assignments: { orderBy: { assignedAt: 'asc' }, take: 1 },
    },
  });
  if (!booking) throw httpError(404, 'Booking not found');
  const started = ['IN_PROGRESS', 'COMPLETED'].includes(booking.status) || new Date(booking.scheduledStart) <= new Date();
  if (booking.status === 'CANCELLED' || !started) throw httpError(409, 'You can only raise a complaint about a visit that has taken place');

  const existing = await prisma.supportTicket.findFirst({
    where: { businessId, bookingId, customerId, kind: 'COMPLAINT', status: { notIn: ['RESOLVED', 'CLOSED'] } },
    select: { id: true },
  });
  if (existing) throw httpError(409, 'You already have an open complaint about this visit');

  const priority = sla.priorityForComplaint(cat);
  const c = booking.customer;
  const name = oneLine(`${c.firstName || ''} ${c.lastName || ''}`, 100);
  const ticket = await prisma.supportTicket.create({
    data: {
      businessId,
      subject: `Complaint: ${cat.replace('_', ' ').toLowerCase()} (${booking.service?.name || 'visit'})`,
      description: text,
      priority,
      category: cat,
      kind: 'COMPLAINT',
      source: 'PORTAL',
      customerId,
      bookingId,
      cleanerId: booking.assignments[0]?.cleanerId || null,
      contactName: name || null,
      contactEmail: (c.email || '').toLowerCase() || null,
      contactPhone: c.phone || null,
      status: 'OPEN',
      dueAt: sla.dueAtFor(priority),
    },
  });
  const reference = referenceFromId(ticket.id);

  try {
    await audit({
      businessId,
      action: 'COMPLAINT_CREATED',
      entityType: 'SupportTicket',
      entityId: ticket.id,
      metadata: { bookingId, category: cat, priority, reference },
    });
    await require('../notifications/notifications.service').notifyMembers(
      businessId,
      'SUPPORT_TICKET',
      priority === 'URGENT' ? 'Urgent customer complaint' : 'New customer complaint',
      `${name || 'A customer'}: ${text.slice(0, 140)}`
    );
  } catch (e) {
    logger.error('complaint follow-up failed', { ticketId: ticket.id, error: e.message });
  }

  return { id: ticket.id, reference, category: cat, priority, status: ticket.status, dueAt: ticket.dueAt };
}

/** A customer's own complaints (newest first), without internal notes. */
async function listMyComplaints(businessId, customerId) {
  const rows = await prisma.supportTicket.findMany({
    where: { businessId, customerId, kind: 'COMPLAINT' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, bookingId: true, category: true, status: true, description: true, createdAt: true, resolvedAt: true },
  });
  return rows.map((r) => ({ ...r, reference: referenceFromId(r.id) }));
}

module.exports = { createComplaint, listMyComplaints, MAX_DESCRIPTION };
