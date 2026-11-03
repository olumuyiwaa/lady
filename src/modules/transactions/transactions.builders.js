/**
 * Turns each kind of money event into a Transaction row (see the model comment
 * in prisma/schema.prisma). Pure functions: no database, no clock except where
 * a caller passes none, so every mapping is unit-testable and the live write
 * sites and the backfill script cannot drift apart.
 *
 * Direction is relative to the business: IN = money received, OUT = money paid
 * or returned. Amounts are always positive cents; zero-amount events are not
 * money movements and are rejected by the service, not here.
 *
 * `dedupeKey` is what makes recording idempotent. It is built from the event's
 * identity (Stripe object id, or the booking for once-only events), never from
 * a timestamp, so a webhook delivered twice, or reaching us by two routes,
 * produces one row.
 */
const crypto = require('crypto');
const { depositPaidCents, jobPaymentCents } = require('../../lib/paymentMath');

// Unknown stays null: transactions.service.record() then uses the business's own currency.
const upper = (c) => (c ? String(c).toUpperCase() : null);
const refOf = (bookingId) => (bookingId ? `#${String(bookingId).slice(-6).toUpperCase()}` : '');
const fullName = (p) => {
  if (!p) return null;
  const n = `${p.firstName || ''} ${p.lastName || ''}`.trim();
  return n || null;
};

// Payout.method is a free string; Transaction.method is an enum.
const PAYOUT_METHOD = { STRIPE: 'STRIPE', MANUAL_CASH: 'CASH', MANUAL_TRANSFER: 'BANK_TRANSFER' };
// Booking payments recorded by hand use their own method names.
const MANUAL_PAYMENT_METHOD = { CASH: 'CASH', BANK_TRANSFER: 'BANK_TRANSFER', INVOICE: 'INVOICE' };

function bookingBase(booking, currency) {
  return {
    businessId: booking.businessId,
    bookingId: booking.id,
    customerId: booking.customerId || null,
    counterpartyName: fullName(booking.customer),
    currency: upper(currency || (booking.business && booking.business.currency)),
  };
}

/** A customer paid the job balance through a Stripe Checkout link. */
function jobPaymentStripe({ booking, sessionId, paymentIntentId, amountCents, currency, occurredAt }) {
  return {
    ...bookingBase(booking, currency),
    type: 'BOOKING_PAYMENT',
    direction: 'IN',
    status: 'SUCCEEDED',
    method: 'STRIPE',
    amountCents,
    occurredAt: occurredAt || new Date(),
    description: `Payment for booking ${refOf(booking.id)}`,
    stripePaymentIntentId: paymentIntentId || null,
    dedupeKey: `jobpay:stripe:${sessionId}`,
  };
}

/**
 * A payment the business recorded by hand (cash, bank transfer...). Several can
 * exist per booking (part-payments), and each is a deliberate user action, so
 * the key is unique per call rather than per booking.
 */
function jobPaymentManual({ booking, method, amountCents, reference, note, currency, occurredAt }) {
  return {
    ...bookingBase(booking, currency),
    type: 'BOOKING_PAYMENT',
    direction: 'IN',
    status: 'SUCCEEDED',
    method: MANUAL_PAYMENT_METHOD[method] || 'OTHER',
    amountCents,
    occurredAt: occurredAt || new Date(),
    description: `Payment recorded for booking ${refOf(booking.id)}`,
    reference: reference ? String(reference).slice(0, 120) : null,
    metadata: note ? { note: String(note).slice(0, 200) } : null,
    dedupeKey: `jobpay:manual:${booking.id}:${crypto.randomUUID()}`,
  };
}

/**
 * The booking's payment status was set to PAID by hand without a payment being
 * recorded. One row per booking, updated if the status is flipped back and
 * forth (see service.record updateOnConflict), so toggling cannot double count.
 */
function jobPaymentStatusFlip({ booking, amountCents, status = 'SUCCEEDED', currency, occurredAt }) {
  return {
    ...bookingBase(booking, currency),
    type: 'BOOKING_PAYMENT',
    direction: 'IN',
    method: 'OTHER',
    status,
    amountCents,
    occurredAt: occurredAt || new Date(),
    description: `Booking ${refOf(booking.id)} marked as paid`,
    dedupeKey: `jobpay:flip:${booking.id}`,
  };
}

function deposit({ booking, sessionId, paymentIntentId, amountCents, currency, occurredAt }) {
  return {
    ...bookingBase(booking, currency),
    type: 'DEPOSIT',
    direction: 'IN',
    status: 'SUCCEEDED',
    method: 'STRIPE',
    amountCents,
    occurredAt: occurredAt || new Date(),
    description: `Deposit for booking ${refOf(booking.id)}`,
    stripePaymentIntentId: paymentIntentId || null,
    // One deposit per booking. sessionId is kept in metadata for support.
    metadata: sessionId ? { sessionId } : null,
    dedupeKey: `deposit:${booking.id}`,
  };
}

function tip({ booking, sessionId, paymentIntentId, amountCents, currency, occurredAt, duplicate = false }) {
  return {
    ...bookingBase(booking, currency),
    type: 'TIP',
    direction: 'IN',
    status: 'SUCCEEDED',
    method: 'STRIPE',
    amountCents,
    occurredAt: occurredAt || new Date(),
    description: duplicate ? `Duplicate tip payment for booking ${refOf(booking.id)}` : `Tip for booking ${refOf(booking.id)}`,
    stripePaymentIntentId: paymentIntentId || null,
    metadata: sessionId ? { sessionId, ...(duplicate ? { duplicate: true } : {}) } : null,
    // A duplicate is a second payment (it is refunded straight away), so it
    // needs its own key; the real tip owns `tip:<bookingId>`.
    dedupeKey: duplicate ? `tip:dup:${sessionId}` : `tip:${booking.id}`,
  };
}

/**
 * Keyed by the Stripe refund id, so our own refund (cancellation) and Stripe's
 * refund.created webhook for that same refund collapse into one row.
 */
function refund({ booking, refundId, paymentIntentId, amountCents, currency, reason, cancellationFeeCents, status = 'SUCCEEDED', description, occurredAt }) {
  return {
    ...bookingBase(booking, currency),
    type: 'REFUND',
    direction: 'OUT',
    method: 'STRIPE',
    status,
    amountCents,
    occurredAt: occurredAt || new Date(),
    description: description || `Refund for booking ${refOf(booking.id)}`,
    stripePaymentIntentId: paymentIntentId || null,
    stripeRefundId: refundId,
    metadata: {
      ...(reason ? { reason } : {}),
      ...(cancellationFeeCents ? { cancellationFeeCents } : {}),
    },
    dedupeKey: `refund:${refundId}`,
  };
}

const DISPUTE_STATUS = {
  won: 'REVERSED', // the money came back
  lost: 'SUCCEEDED', // the money is gone
  warning_closed: 'REVERSED', // an inquiry that never became a chargeback
};

/** Stripe dispute status -> ours. Anything still open is PENDING. */
function disputeStatus(stripeStatus) {
  return DISPUTE_STATUS[stripeStatus] || 'PENDING';
}

function dispute({ booking, disputeId, paymentIntentId, amountCents, currency, stripeStatus, occurredAt }) {
  return {
    ...bookingBase(booking, currency),
    type: 'DISPUTE',
    direction: 'OUT',
    method: 'STRIPE',
    status: disputeStatus(stripeStatus),
    amountCents,
    occurredAt: occurredAt || new Date(),
    description: `Payment dispute on booking ${refOf(booking.id)}`,
    stripePaymentIntentId: paymentIntentId || null,
    stripeDisputeId: disputeId,
    dedupeKey: `dispute:${disputeId}`,
  };
}

/** A payout to a cleaner, once it is actually PAID. */
function cleanerPayout({ payout, cleanerName, currency }) {
  return {
    businessId: payout.businessId,
    cleanerId: payout.cleanerId,
    payoutId: payout.id,
    counterpartyName: cleanerName || null,
    currency: upper(currency),
    type: 'CLEANER_PAYOUT',
    direction: 'OUT',
    status: 'SUCCEEDED',
    method: PAYOUT_METHOD[payout.method] || 'OTHER',
    amountCents: payout.totalCents,
    occurredAt: payout.paidAt || new Date(),
    description: 'Cleaner payout',
    reference: payout.reference ? String(payout.reference).slice(0, 120) : null,
    stripeTransferId: payout.stripeTransferId || null,
    dedupeKey: `payout:${payout.id}`,
  };
}

/** The business paying Lady Greener. FAILED rows become SUCCEEDED when a retry works. */
function subscriptionInvoice({ businessId, platformInvoiceId, invoiceId, amountCents, currency, paid, occurredAt }) {
  return {
    businessId,
    platformInvoiceId: platformInvoiceId || null,
    counterpartyName: 'Lady Greener',
    currency: upper(currency),
    type: 'SUBSCRIPTION',
    direction: 'OUT',
    method: 'STRIPE',
    status: paid ? 'SUCCEEDED' : 'FAILED',
    amountCents,
    occurredAt: occurredAt || new Date(),
    description: paid ? 'Lady Greener subscription' : 'Lady Greener subscription payment failed',
    stripeInvoiceId: invoiceId,
    dedupeKey: `subinv:${invoiceId}`,
  };
}

/**
 * Everything the backfill can reconstruct from a booking row. The job payment
 * has no timestamp of its own, so its date is the best available guess and the
 * row says so (metadata.dateApproximate).
 */
function rowsFromBooking(booking) {
  const rows = [];
  const base = bookingBase(booking);
  const backfilled = { backfilled: true };

  const depositCents = depositPaidCents(booking);
  if (depositCents > 0) {
    rows.push({
      ...deposit({
        booking,
        paymentIntentId: booking.stripeDepositPaymentIntentId,
        amountCents: depositCents,
        occurredAt: booking.depositPaidAt,
      }),
      ...backfilled,
    });
  }
  if (booking.tipPaidAt && booking.tipAmountCents > 0) {
    rows.push({
      ...tip({
        booking,
        paymentIntentId: booking.stripeTipPaymentIntentId,
        amountCents: booking.tipAmountCents,
        occurredAt: booking.tipPaidAt,
      }),
      ...backfilled,
    });
  }
  // jobPaymentCents (not the raw column): bookings marked PAID by hand before
  // amountPaidCents existed have it null, and would otherwise be missing.
  const jobCents = jobPaymentCents(booking);
  if (jobCents > 0) {
    const viaStripe = !!booking.stripePaymentIntentId;
    rows.push({
      ...base,
      type: 'BOOKING_PAYMENT',
      direction: 'IN',
      method: viaStripe ? 'STRIPE' : 'OTHER',
      amountCents: jobCents,
      occurredAt: booking.paidAtGuess || booking.updatedAt || booking.createdAt,
      description: `Payment for booking ${refOf(booking.id)}`,
      stripePaymentIntentId: booking.stripePaymentIntentId || null,
      // The booking stores one cumulative figure with no date, and Stripe plus
      // hand-recorded part-payments can be mixed in it. Say so rather than guess.
      metadata: { dateApproximate: true, ...(viaStripe ? { methodApproximate: true } : {}) },
      dedupeKey: `jobpay:backfill:${booking.id}`,
      ...backfilled,
    });
  }
  if (booking.refundedAt && booking.refundedAmountCents > 0) {
    const ids = String(booking.stripeRefundId || '').split(',').map((s) => s.trim()).filter(Boolean);
    // A booking can only store the joined ids and one total. With a single id the
    // row is exact and shares its key with the live webhook; with several, the
    // per-refund split is unknown, so it stays one approximate row.
    rows.push({
      ...base,
      type: 'REFUND',
      direction: 'OUT',
      method: 'STRIPE',
      amountCents: booking.refundedAmountCents,
      occurredAt: booking.refundedAt,
      description: `Refund for booking ${refOf(booking.id)}`,
      stripeRefundId: ids.length === 1 ? ids[0] : null,
      metadata: ids.length > 1 ? { refundIds: ids, combined: true } : null,
      dedupeKey: ids.length === 1 ? `refund:${ids[0]}` : `refund:backfill:${booking.id}`,
      ...backfilled,
    });
  }
  return rows;
}

function rowFromPayout(payout, { cleanerName, currency }) {
  return { ...cleanerPayout({ payout, cleanerName, currency }), backfilled: true };
}

function rowFromPlatformInvoice(inv, { businessId, currency }) {
  return {
    ...subscriptionInvoice({
      businessId,
      platformInvoiceId: inv.id,
      invoiceId: inv.stripeInvoiceId,
      amountCents: inv.amountCents,
      currency,
      paid: inv.status === 'paid',
      occurredAt: inv.paidAt || inv.issuedAt,
    }),
    backfilled: true,
  };
}

module.exports = {
  jobPaymentStripe,
  jobPaymentManual,
  jobPaymentStatusFlip,
  deposit,
  tip,
  refund,
  dispute,
  disputeStatus,
  cleanerPayout,
  subscriptionInvoice,
  rowsFromBooking,
  rowFromPayout,
  rowFromPlatformInvoice,
  fullName,
};
