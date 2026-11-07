const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { audit } = require('../../utils/audit');
const { leaveWindow, httpError } = require('../../lib/leave');

const TYPES = ['VACATION', 'SICK', 'PERSONAL', 'OTHER'];
const include = { cleaner: { select: { id: true, user: { select: { firstName: true, lastName: true } } } } };

async function businessZone(businessId) {
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } });
  return (biz && biz.timezone) || 'Europe/Amsterdam';
}

/** Another pending/approved leave of this cleaner that overlaps the window. */
async function findOverlap(cleanerId, startsAt, endsAt, excludeId) {
  return prisma.cleanerLeave.findFirst({
    where: {
      cleanerId,
      status: { in: ['PENDING', 'APPROVED'] },
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

/** Bookings this cleaner is assigned to inside the window, so a manager can reassign them. */
async function conflictingBookings(cleanerId, startsAt, endsAt) {
  const rows = await prisma.bookingAssignment.findMany({
    where: { cleanerId, booking: { status: { notIn: ['CANCELLED', 'COMPLETED'] }, scheduledStart: { lt: endsAt }, scheduledEnd: { gt: startsAt } } },
    include: { booking: { select: { id: true, scheduledStart: true, scheduledEnd: true, addressLine1: true, city: true } } },
  });
  return rows.map((r) => r.booking);
}

async function create({ businessId, cleanerId, type = 'VACATION', startDate, endDate, reason, createdById = null, autoApprove = false }) {
  if (!TYPES.includes(type)) throw httpError(400, 'Invalid leave type');
  const cleaner = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!cleaner) throw httpError(404, 'Cleaner not found for this business');

  const { startsAt, endsAt } = leaveWindow(startDate, endDate, await businessZone(businessId));
  // Sick leave may be entered for today or a day already started; anything
  // that ended before today is history and not accepted.
  if (endsAt.getTime() <= Date.now()) throw httpError(400, 'Leave must not be entirely in the past');
  if (await findOverlap(cleanerId, startsAt, endsAt)) throw httpError(409, 'This overlaps leave that is already requested or approved');

  const leave = await prisma.cleanerLeave.create({
    data: {
      businessId, cleanerId, type, startsAt, endsAt,
      reason: reason ? String(reason).slice(0, 500) : null,
      createdById,
      ...(autoApprove ? { status: 'APPROVED', decidedById: createdById, decidedAt: new Date() } : {}),
    },
    include,
  });
  await audit({ businessId, actorUserId: createdById, action: autoApprove ? 'LEAVE_RECORDED' : 'LEAVE_REQUESTED', entityType: 'CleanerLeave', entityId: leave.id }).catch(() => {});
  const conflicts = autoApprove ? await conflictingBookings(cleanerId, startsAt, endsAt) : [];
  return { leave, conflicts };
}

async function list(businessId, { status, cleanerId, from, to } = {}) {
  return prisma.cleanerLeave.findMany({
    where: {
      businessId,
      ...(status ? { status } : {}),
      ...(cleanerId ? { cleanerId } : {}),
      ...(from ? { endsAt: { gt: new Date(from) } } : {}),
      ...(to ? { startsAt: { lt: new Date(to) } } : {}),
    },
    include,
    orderBy: [{ startsAt: 'asc' }],
    take: 500,
  });
}

async function listForCleaner(cleanerId) {
  return prisma.cleanerLeave.findMany({ where: { cleanerId }, orderBy: { startsAt: 'desc' }, take: 100 });
}

async function loadInBusiness(businessId, id) {
  const leave = await prisma.cleanerLeave.findFirst({ where: { id, businessId }, include: { cleaner: { include: { user: true } } } });
  if (!leave) throw httpError(404, 'Leave request not found');
  return leave;
}

async function notifyCleaner(leave, title, body) {
  try {
    await require('../notifications/notifications.service').pushToCleanerByUserId(leave.cleaner.userId, { title, body, data: { type: 'LEAVE', leaveId: leave.id, status: leave.status } });
  } catch (e) {
    logger.warn('leave push failed', { error: e.message });
  }
}

async function decide(businessId, id, actorUserId, decision, note) {
  const leave = await loadInBusiness(businessId, id);
  if (leave.status !== 'PENDING') throw httpError(409, `Only pending requests can be ${decision === 'APPROVED' ? 'approved' : 'rejected'}`);
  const updated = await prisma.cleanerLeave.update({
    where: { id },
    data: { status: decision, decisionNote: note ? String(note).slice(0, 500) : null, decidedById: actorUserId, decidedAt: new Date() },
    include,
  });
  await audit({ businessId, actorUserId, action: decision === 'APPROVED' ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED', entityType: 'CleanerLeave', entityId: id }).catch(() => {});
  await notifyCleaner(leave, decision === 'APPROVED' ? 'Leave approved' : 'Leave not approved', decision === 'APPROVED' ? 'Your leave request was approved.' : (note || 'Your leave request was not approved.'));
  // Approved leave does not move existing jobs; the manager gets the list to reassign.
  const conflicts = decision === 'APPROVED' ? await conflictingBookings(leave.cleanerId, leave.startsAt, leave.endsAt) : [];
  return { leave: updated, conflicts };
}

const approve = (businessId, id, actorUserId, note) => decide(businessId, id, actorUserId, 'APPROVED', note);
const reject = (businessId, id, actorUserId, note) => decide(businessId, id, actorUserId, 'REJECTED', note);

/** Cancels a pending or approved leave that has not ended. cleanerId limits it to the cleaner's own records. */
async function cancel(businessId, id, { actorUserId, cleanerId } = {}) {
  const leave = await loadInBusiness(businessId, id);
  if (cleanerId && leave.cleanerId !== cleanerId) throw httpError(404, 'Leave request not found');
  if (!['PENDING', 'APPROVED'].includes(leave.status)) throw httpError(409, 'This leave is already closed');
  if (leave.endsAt.getTime() <= Date.now()) throw httpError(409, 'This leave has already ended');
  const updated = await prisma.cleanerLeave.update({ where: { id }, data: { status: 'CANCELLED' }, include });
  await audit({ businessId, actorUserId, action: 'LEAVE_CANCELLED', entityType: 'CleanerLeave', entityId: id }).catch(() => {});
  return updated;
}

module.exports = { create, list, listForCleaner, approve, reject, cancel, conflictingBookings };
