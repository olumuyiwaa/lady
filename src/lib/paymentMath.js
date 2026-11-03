/**
 * Money arithmetic for a booking, in minor units. Kept in one place because
 * the payment link, the auto-charge at completion, manual "mark as paid",
 * and cancellation refunds all need the same answer to "what has been paid
 * and what is still owed?". They previously each used quotedPriceCents
 * directly, which charged customers again for deposits and gift cards.
 */

const nonNegative = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** Deposit actually received (0 when none was paid). */
function depositPaidCents(booking) {
  return booking.depositPaidAt ? nonNegative(booking.depositRequiredCents) : 0;
}

/**
 * Received against the job itself, excluding the deposit. Rows marked PAID
 * before amountPaidCents was tracked (manual "mark as paid") are treated as
 * having paid whatever was due at the time.
 */
function jobPaymentCents(booking) {
  if (booking.amountPaidCents != null) return nonNegative(booking.amountPaidCents);
  if (booking.paymentStatus === 'PAID') {
    return nonNegative(nonNegative(booking.quotedPriceCents) - nonNegative(booking.giftCardAppliedCents) - depositPaidCents(booking));
  }
  return 0;
}

/** Total received in cash terms: deposit plus job payment(s). Gift card value is not cash and is excluded. */
function paidSoFarCents(booking) {
  return depositPaidCents(booking) + jobPaymentCents(booking);
}

/** What the customer still owes: quote, less gift card, less anything already received. */
function amountDueCents(booking) {
  return Math.max(
    0,
    nonNegative(booking.quotedPriceCents) - nonNegative(booking.giftCardAppliedCents) - paidSoFarCents(booking)
  );
}

/**
 * Splits a refund across the Stripe payments that funded it. The job payment
 * is refunded first (usually the larger charge), then the deposit. Anything
 * that was not paid through Stripe (cash, bank transfer) cannot be refunded
 * by API and is returned as manualCents for the business to settle by hand.
 * A single PaymentIntent can never be refunded for more than it captured;
 * asking Stripe to refund the combined total against one intent is rejected.
 */
function buildRefundPlan(booking, refundCents) {
  let remaining = nonNegative(refundCents);
  const items = [];

  const stripeJob = booking.stripePaymentIntentId ? jobPaymentCents(booking) : 0;
  const stripeDeposit = booking.stripeDepositPaymentIntentId ? depositPaidCents(booking) : 0;

  const fromJob = Math.min(remaining, stripeJob);
  if (fromJob > 0) {
    items.push({ paymentIntentId: booking.stripePaymentIntentId, amountCents: fromJob });
    remaining -= fromJob;
  }
  const fromDeposit = Math.min(remaining, stripeDeposit);
  if (fromDeposit > 0) {
    items.push({ paymentIntentId: booking.stripeDepositPaymentIntentId, amountCents: fromDeposit });
    remaining -= fromDeposit;
  }
  return { items, manualCents: remaining };
}

module.exports = { depositPaidCents, jobPaymentCents, paidSoFarCents, amountDueCents, buildRefundPlan };
