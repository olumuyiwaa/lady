const prisma = require('../config/database');

/**
 * How many more bookings the business can take in [start, end): free cleaners
 * minus unassigned bookings that already overlap the window. `excludeBookingId`
 * lets a booking that is being moved ignore its own old slot.
 *
 * (Moved out of widget.service so the customer portal's reschedule uses the
 * same rule; it used to skip the unassigned-bookings part and could oversell.)
 */
async function spareCapacity(businessId, start, end, opts = {}) {
  const { excludeBookingId, ...schedulerOpts } = opts;
  const scheduler = require('./scheduler');
  const candidates = (await scheduler.findAvailableCleaners(businessId, start, end, schedulerOpts)) || [];
  const unassigned = await prisma.booking.count({
    where: {
      businessId,
      status: { in: ['REQUESTED', 'CONFIRMED'] },
      assignments: { none: {} },
      scheduledStart: { lt: end },
      scheduledEnd: { gt: start },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
  });
  return { candidates, spare: Math.max(0, candidates.length - unassigned) };
}

module.exports = { spareCapacity };
