const prisma = require('../../config/database');
const crypto = require('crypto');

/**
 * `requester` (optional) is the authenticate() result: { businessRole, cleanerProfileId }.
 * A CLEANER requester is restricted to checklists for bookings they're
 * actually assigned to — cleaners must not see or touch the whole business's
 * job checklists. Staff/owner/manager/SUPER_ADMIN are unaffected.
 */
function cleanerAssignmentFilter(requester) {
  if (requester?.businessRole !== 'CLEANER') return {};
  return { assignments: { some: { cleanerId: requester.cleanerProfileId } } };
}

/**
 * Ensures every item has a stable `id` so a single item can be targeted
 * later (see completeChecklistItem) without replacing the whole array.
 * Older checklists created before items carried ids get one assigned the
 * first time they're read/written through this service.
 */
function withItemIds(items) {
  return (items || []).map((item) => ({ id: item.id || crypto.randomUUID(), ...item }));
}

async function listChecklists(businessId, requester = null) {
  return prisma.jobChecklist.findMany({
    where: { booking: { businessId, ...cleanerAssignmentFilter(requester) } },
    include: { booking: true },
  });
}

async function getChecklist(businessId, bookingId, requester = null) {
  const c = await prisma.jobChecklist.findFirst({
    where: { bookingId },
    include: { booking: { include: { assignments: true } } },
  });
  if (!c || c.booking.businessId !== businessId) {
    const err = new Error('Checklist not found');
    err.status = 404;
    throw err;
  }

  if (requester?.businessRole === 'CLEANER') {
    const assigned = c.booking.assignments.some((a) => a.cleanerId === requester.cleanerProfileId);
    if (!assigned) {
      // 404, not 403 — don't confirm to a cleaner that a job they're not on
      // even exists.
      const err = new Error('Checklist not found');
      err.status = 404;
      throw err;
    }
  }

  return { ...c, items: withItemIds(c.items) };
}

async function createChecklist(businessId, bookingId, items, requester = null) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId },
    include: { assignments: true },
  });
  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }

  if (requester?.businessRole === 'CLEANER') {
    const assigned = booking.assignments.some((a) => a.cleanerId === requester.cleanerProfileId);
    if (!assigned) {
      const err = new Error('Booking not found');
      err.status = 404;
      throw err;
    }
  }

  const created = await prisma.jobChecklist.create({ data: { bookingId, items: withItemIds(items) } });
  return created;
}

async function updateChecklist(businessId, bookingId, items, requester = null) {
  const c = await getChecklist(businessId, bookingId, requester);
  const updated = await prisma.jobChecklist.update({ where: { id: c.id }, data: { items: withItemIds(items) } });
  return updated;
}

async function deleteChecklist(businessId, bookingId, requester = null) {
  const c = await getChecklist(businessId, bookingId, requester);
  await prisma.jobChecklist.delete({ where: { id: c.id } });
}

/**
 * Marks a single item done (or not) without the caller having to fetch,
 * mutate, and PUT back the entire items array — this is what a cleaner
 * checking off items during a job actually needs. Uses the same
 * assignment-scoping as getChecklist, so a cleaner can only tick items on
 * their own assigned jobs.
 */
async function completeChecklistItem(businessId, bookingId, itemId, done, requester = null) {
  const c = await getChecklist(businessId, bookingId, requester);
  const items = c.items;
  const idx = items.findIndex((i) => i.id === itemId);
  if (idx === -1) {
    const err = new Error('Checklist item not found');
    err.status = 404;
    throw err;
  }

  items[idx] = { ...items[idx], done: done !== undefined ? !!done : true };
  const allDone = items.every((i) => i.done);

  const updated = await prisma.jobChecklist.update({
    where: { id: c.id },
    data: { items, completedAt: allDone ? new Date() : null },
  });

  return { checklist: updated, item: items[idx] };
}

module.exports.listChecklists = listChecklists;
module.exports.getChecklist = getChecklist;
module.exports.createChecklist = createChecklist;
module.exports.updateChecklist = updateChecklist;
module.exports.deleteChecklist = deleteChecklist;
module.exports.completeChecklistItem = completeChecklistItem;
