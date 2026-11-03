/**
 * How long a booking that requires a deposit holds its slot while the customer
 * is on the Stripe payment page. Stripe Checkout sessions can expire between
 * 30 minutes and 24 hours after creation; the booking is cancelled when the
 * session expires unpaid (webhook) or by the sweeper as a fallback.
 */
const MIN_MINUTES = 30;
const MAX_MINUTES = 24 * 60;
const DEFAULT_MINUTES = 60;

function depositHoldMinutes() {
  const n = Number(process.env.DEPOSIT_HOLD_MINUTES);
  const v = Number.isFinite(n) && n > 0 ? n : DEFAULT_MINUTES;
  return Math.min(Math.max(Math.round(v), MIN_MINUTES), MAX_MINUTES);
}

module.exports = { depositHoldMinutes };
