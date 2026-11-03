const prisma = require('../config/database');
const logger = require('../config/logger');
const { depositHoldMinutes } = require('../lib/depositHold');
const { expireCheckoutSession } = require('../lib/stripeClient');

/**
 * Fallback for the checkout.session.expired webhook: cancels bookings that
 * asked for a deposit, never received it, and have outlived the hold window.
 * Without this an unpaid (or abusive) booking blocks its slot indefinitely.
 *
 * Only REQUESTED, unassigned bookings are touched: once staff confirm or
 * assign a booking by hand, they have decided to keep it.
 */
const GRACE_MINUTES = 15; // let the webhook go first

async function sweepUnpaidDeposits({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - (depositHoldMinutes() + GRACE_MINUTES) * 60 * 1000);
  const stale = await prisma.booking.findMany({
    where: {
      status: 'REQUESTED',
      depositRequiredCents: { gt: 0 },
      depositPaidAt: null,
      stripeDepositSessionId: { not: null },
      createdAt: { lt: cutoff },
      assignments: { none: {} },
    },
    select: { id: true, businessId: true, stripeDepositSessionId: true, business: { select: { stripeConnectedAccountId: true } } },
    take: 100,
    orderBy: { createdAt: 'asc' },
  });

  const bookingsService = require('../modules/bookings/bookings.service');
  const stats = { scanned: stale.length, cancelled: 0, errors: 0 };
  for (const b of stale) {
    try {
      await expireCheckoutSession(b.stripeDepositSessionId, b.business && b.business.stripeConnectedAccountId);
      await bookingsService.cancelBooking(b.businessId, b.id, null, 'Deposit was not paid in time', { waiveFee: true });
      stats.cancelled += 1;
    } catch (e) {
      stats.errors += 1;
      logger.error('deposit sweeper failed for booking', { bookingId: b.id, error: e.message });
    }
  }
  if (stats.scanned) logger.info('deposit sweeper finished', stats);
  return stats;
}

if (require.main === module) {
  sweepUnpaidDeposits()
    .then((s) => process.exit(s.errors ? 1 : 0))
    .catch((e) => {
      logger.error('deposit sweeper failed', e);
      process.exit(1);
    });
}

module.exports = { sweepUnpaidDeposits };
