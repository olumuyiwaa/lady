const prisma = require('../config/database');

/**
 * Returns an existing assignment that overlaps [start, end) for this cleaner,
 * or null. Bookings that touch (one ends exactly when the next starts) do not
 * conflict — the previous checks used lte/gte, so back-to-back jobs for the
 * same cleaner were impossible. Cancelled bookings never block, because their
 * assignment rows are not removed on cancel.
 *
 * Every path that assigns a cleaner (assign, dispatch, reassign) must go
 * through this so they cannot disagree; the dispatch path previously had no
 * check at all.
 */
async function findCleanerConflict(cleanerId, start, end, { excludeBookingId } = {}) {
  return prisma.bookingAssignment.findFirst({
    where: {
      cleanerId,
      ...(excludeBookingId ? { bookingId: { not: excludeBookingId } } : {}),
      booking: {
        status: { not: 'CANCELLED' },
        scheduledStart: { lt: end },
        scheduledEnd: { gt: start },
      },
    },
    include: { booking: { select: { id: true, scheduledStart: true, scheduledEnd: true } } },
  });
}

async function assertCleanerFree(cleanerId, start, end, opts = {}) {
  const conflict = await findCleanerConflict(cleanerId, start, end, opts);
  if (conflict) {
    const err = new Error('Cleaner has another booking during this time');
    err.status = 409;
    err.conflictingBookingId = conflict.booking.id;
    throw err;
  }
}

module.exports = { findCleanerConflict, assertCleanerFree };
