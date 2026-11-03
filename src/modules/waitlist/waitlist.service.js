const prisma = require('../../config/database');
const logger = require('../../config/logger');

/**
 * A customer joins the waitlist when the widget has no open slot for the
 * date range they wanted (see widget.service.quote/submitBooking throwing
 * "No cleaners available..." — the widget frontend catches that and offers
 * this instead of a dead end). Guest-friendly: customerId is optional, a
 * contactEmail or contactPhone is required so there's something to notify.
 */
async function joinWaitlist(businessId, payload = {}) {
  const {
    serviceId,
    desiredStart,
    desiredEnd,
    customerId,
    contactName,
    contactEmail,
    contactPhone,
    notes,
  } = payload;

  if (!desiredStart || !desiredEnd) {
    const err = new Error('desiredStart and desiredEnd are required');
    err.status = 422;
    throw err;
  }
  const start = new Date(desiredStart);
  const end = new Date(desiredEnd);
  if (!(end > start)) {
    const err = new Error('desiredEnd must be after desiredStart');
    err.status = 422;
    throw err;
  }
  if (!contactEmail && !contactPhone) {
    const err = new Error('contactEmail or contactPhone is required');
    err.status = 422;
    throw err;
  }

  if (serviceId) {
    const service = await prisma.service.findFirst({ where: { id: serviceId, businessId, isActive: true } });
    if (!service) {
      const err = new Error('Service not found');
      err.status = 404;
      throw err;
    }
  }

  return prisma.waitlistEntry.create({
    data: {
      businessId,
      serviceId: serviceId || null,
      customerId: customerId || null,
      contactName: contactName || null,
      contactEmail: contactEmail || null,
      contactPhone: contactPhone || null,
      desiredStart: start,
      desiredEnd: end,
      notes: notes || null,
    },
  });
}

async function listWaitlist(businessId, { status } = {}) {
  return prisma.waitlistEntry.findMany({
    where: { businessId, ...(status ? { status } : {}) },
    include: { customer: { select: { firstName: true, lastName: true } }, service: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });
}

async function cancelWaitlistEntry(businessId, id) {
  const entry = await prisma.waitlistEntry.findFirst({ where: { id, businessId } });
  if (!entry) {
    const err = new Error('Waitlist entry not found');
    err.status = 404;
    throw err;
  }
  return prisma.waitlistEntry.update({ where: { id }, data: { status: 'CANCELLED' } });
}

/**
 * Best-effort: checks the waitlist for entries whose desired window overlaps
 * a slot that just opened up (a cancellation freeing capacity), confirms a
 * cleaner can actually cover it, and notifies the first few matches. Caps at
 * MAX_NOTIFIED so one freed slot can't blast an entire waitlist — the first
 * to respond and book gets it, same as any other waitlist.
 *
 * Called from bookings.service.cancelBooking non-fatally (a notification
 * failure should never fail the cancellation itself), same pattern as the
 * refund/notification calls already in that function.
 */
const MAX_NOTIFIED = 5;

async function notifyWaitlistForFreedSlot(businessId, { serviceId, scheduledStart, scheduledEnd }) {
  if (!scheduledStart || !scheduledEnd) return { notified: 0 };

  const candidates = await prisma.waitlistEntry.findMany({
    where: {
      businessId,
      status: 'WAITING',
      OR: [{ serviceId: null }, { serviceId }],
      desiredStart: { lte: scheduledEnd },
      desiredEnd: { gte: scheduledStart },
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_NOTIFIED,
  });
  if (candidates.length === 0) return { notified: 0 };

  // Confirm the freed window is actually coverable before notifying anyone
  // — a booking being cancelled doesn't guarantee a cleaner is free for
  // every waitlisted service's estimated duration at that time.
  const scheduler = require('../../lib/scheduler');
  const available = await scheduler.findAvailableCleaners(businessId, new Date(scheduledStart), new Date(scheduledEnd), {});
  if (!available || available.length === 0) return { notified: 0 };

  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true } });
  const notificationClient = require('../../lib/notificationClient');
  let notified = 0;

  for (const entry of candidates) {
    try {
      const msg = `${business?.name || 'Your cleaning business'}: a slot just opened up for ${new Date(
        scheduledStart
      ).toLocaleString()}. Book now before it's gone!`;
      if (entry.contactPhone) await notificationClient.sendSms({ to: entry.contactPhone, body: msg });
      if (entry.contactEmail) {
        await notificationClient.sendEmail({
          to: entry.contactEmail,
          subject: `${business?.name || 'Lady Greener'}: a slot opened up`,
          text: msg,
          html: `<p>${msg}</p>`,
        });
      }
      await prisma.waitlistEntry.update({ where: { id: entry.id }, data: { status: 'NOTIFIED', notifiedAt: new Date() } });
      notified += 1;
    } catch (e) {
      logger.error('waitlist notification failed', { waitlistEntryId: entry.id, error: e.message });
      // non-fatal — move on to the next candidate rather than aborting all of them
    }
  }

  return { notified };
}

module.exports = {
  joinWaitlist,
  listWaitlist,
  cancelWaitlistEntry,
  notifyWaitlistForFreedSlot,
};
