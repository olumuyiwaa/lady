const prisma = require('../config/database');
const { paidSoFarCents, buildRefundPlan } = require('./paymentMath');

/**
 * Resolves what a cancellation of `booking` should cost right now, and how
 * much of what's already been paid (deposit and/or job payment) should come
 * back to the customer.
 *
 * Policy comes from BusinessPricing — a business that has never configured
 * cancellationWindowHours pays nothing on cancellation, ever, which matches
 * the platform's original (implicit) behavior. Setting a window turns on a
 * fee for cancellations made inside that many hours of scheduledStart.
 *
 * This does not itself touch the database or Stripe — callers apply the
 * result (see bookings.service.cancelBooking and
 * customerPortal.service.cancelMyBooking).
 */
async function evaluateCancellation(businessId, booking, { now = new Date(), waiveFee = false } = {}) {
  const pricing = await prisma.businessPricing.findUnique({ where: { businessId } });

  const hoursUntilStart = (new Date(booking.scheduledStart).getTime() - now.getTime()) / 3600000;

  // Deposit + job payment(s), including part-payments recorded by hand.
  const alreadyPaidCents = paidSoFarCents(booking);

  const noPolicy = !pricing || pricing.cancellationWindowHours == null;
  const withinFreeWindow = waiveFee || noPolicy || hoursUntilStart >= pricing.cancellationWindowHours;

  let feeCents = 0;
  if (!withinFreeWindow) {
    if (pricing.cancellationFeeType === 'PERCENT') {
      feeCents = Math.round((booking.quotedPriceCents * (pricing.cancellationFeeValue || 0)) / 100);
    } else if (pricing.cancellationFeeType === 'AMOUNT') {
      feeCents = pricing.cancellationFeeValue || 0;
    }
    // Never charge more than was actually collected, and never more than
    // the job was quoted for.
    feeCents = Math.min(feeCents, alreadyPaidCents, booking.quotedPriceCents || feeCents);
  }

  const refundCents = Math.max(alreadyPaidCents - feeCents, 0);
  const refundPlan = buildRefundPlan(booking, refundCents);

  return {
    hoursUntilStart,
    withinFreeWindow,
    alreadyPaidCents,
    feeCents,
    refundCents,
    // One entry per Stripe PaymentIntent to refund, each within what that
    // intent actually captured (deposit and job payment are separate charges).
    refundPlan: refundPlan.items,
    // The part paid outside Stripe (cash / bank transfer): the business has
    // to return this itself.
    manualRefundCents: refundPlan.manualCents,
    // Kept for callers that only handle a single intent.
    refundPaymentIntentId: booking.stripePaymentIntentId || booking.stripeDepositPaymentIntentId || null,
  };
}

module.exports = { evaluateCancellation };
