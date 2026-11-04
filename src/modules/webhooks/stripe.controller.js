const { retrieveEvent } = require('../../lib/stripeClient');
const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { audit } = require('../../utils/audit');
const transactions = require('../transactions/transactions.service');
const txRows = require('../transactions/transactions.builders');

/**
 * Job payments are direct charges, so their events arrive with event.account =
 * the business's connected account. A booking may only be touched by events
 * from ITS business's account: metadata alone must not let one tenant's
 * Stripe account mark another tenant's booking paid. Events without
 * event.account (platform-level, e.g. legacy destination charges) pass.
 */
async function accountMatchesBooking(event, booking) {
  if (!event.account) return true;
  const biz = await prisma.business.findUnique({
    where: { id: booking.businessId },
    select: { stripeConnectedAccountId: true },
  });
  if (biz && biz.stripeConnectedAccountId === event.account) return true;
  logger.error('Stripe event account does not match the booking business; ignored', {
    eventId: event.id,
    eventAccount: event.account,
    bookingId: booking.id,
  });
  return false;
}

/**
 * Applies a guarded booking update. The `where` carries the same condition the
 * handler checked a moment earlier (e.g. paymentStatus != PAID), so when two
 * deliveries of one event race, only the first write matches. The loser gets
 * Prisma's "record not found" (P2025) and reports `false` instead of
 * double-counting money.
 */
async function updateBookingOnce(args) {
  try {
    await prisma.booking.update(args);
    return true;
  } catch (e) {
    if (e && e.code === 'P2025') return false;
    throw e;
  }
}

/**
 * A second paid tip for a booking that already has one (two Checkout tabs open
 * at once). Money was taken but nothing is recorded for it, so hand it back.
 */
async function refundDuplicateTip(event, booking, session) {
  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null;
  logger.warn('Duplicate tip payment received; refunding', { bookingId: booking.id, sessionId: session.id });
  let refunded = false;
  let refundObj = null;
  try {
    const stripeClient = require('../../lib/stripeClient');
    const r = await stripeClient.createRefund({
      paymentIntentId,
      reason: 'duplicate',
      connectedAccountId: event.account || require('../../lib/stripeClient').DIRECT_ACCOUNT,
      idempotencyKey: `dup-tip-${session.id}`,
    });
    refunded = !!r;
    refundObj = r;
  } catch (e) {
    logger.error('Duplicate tip refund failed; needs manual refund', { sessionId: session.id, error: e.message });
  }
  // The duplicate payment really arrived, so it is logged as money in; the refund
  // (when it worked) is the matching money out. Net zero, and nothing is hidden.
  await transactions.record(txRows.tip({
    booking, sessionId: session.id, paymentIntentId, amountCents: session.amount_total, currency: session.currency, duplicate: true,
  }));
  if (refunded && refundObj && refundObj.id) {
    await transactions.record(txRows.refund({
      booking, refundId: refundObj.id, paymentIntentId, amountCents: session.amount_total, currency: session.currency,
      reason: 'duplicate', description: 'Refund of duplicate tip payment',
    }));
  }
  await audit({
    businessId: booking.businessId,
    actorUserId: null,
    action: refunded ? 'BOOKING_TIP_DUPLICATE_REFUNDED' : 'BOOKING_TIP_DUPLICATE_NEEDS_REFUND',
    entityType: 'Booking',
    entityId: booking.id,
    metadata: { sessionId: session.id, paymentIntentId, amountTotal: session.amount_total },
  });
}

const paymentIntentIdOf = (pi) => (typeof pi === 'string' ? pi : (pi && pi.id) || null);
const toDate = (unixSeconds) => (unixSeconds ? new Date(unixSeconds * 1000) : null);

async function handle(req, res) {
  let event;
  try {
    event = await retrieveEvent(req.rawBody || req.body, req.headers['stripe-signature']);
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  // No secret configured: refuse rather than acknowledge. Answering 200 made a
  // misconfigured production deploy look healthy while dropping every event.
  if (!event) {
    logger.error('Stripe webhook received but no signing secret is configured (STRIPE_WEBHOOK_SECRETS / STRIPE_WEBHOOK_SECRET)');
    return res.status(503).json({ received: false, message: 'Webhook signing secret not configured' });
  }

  const type = event.type;
  const obj = event.data.object;

  try {
    if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
      const meta = obj.metadata || {};
      if (obj.payment_status && obj.payment_status !== 'paid') {
        // Asynchronous payment methods (SEPA debit, bank redirects) complete the
        // session before money arrives; checkout.session.async_payment_succeeded
        // follows when it does. Do not mark anything paid yet.
        logger.info(`Checkout session ${obj.id} completed with payment_status=${obj.payment_status}; waiting for async confirmation`);
      } else if (meta.purpose === 'job_payment' && meta.bookingId) {
        const booking = await prisma.booking.findUnique({ where: { id: meta.bookingId } });
        if (booking && booking.paymentStatus !== 'PAID' && (await accountMatchesBooking(event, booking))) {
          const paymentIntentId =
              typeof obj.payment_intent === 'string'
                  ? obj.payment_intent
                  : obj.payment_intent?.id || null;

          const applied = await updateBookingOnce({
            where: { id: meta.bookingId, paymentStatus: { not: 'PAID' } },
            data: {
              paymentStatus: 'PAID',
              stripeCheckoutSessionId: obj.id,
              stripePaymentIntentId: paymentIntentId,
              // Additive: part of the balance may already have been recorded by
              // hand (cash/bank transfer). The link only charges what was still due.
              // `increment` is applied by the database, not computed from the row we read.
              amountPaidCents: { increment: obj.amount_total ?? 0 },
              paymentNote: `stripe_session:${obj.id};paid_at:${new Date().toISOString()}`,
            },
          });

          if (applied) await audit({
            businessId: meta.businessId || booking.businessId,
            actorUserId: null,
            action: 'BOOKING_PAYMENT_RECEIVED',
            entityType: 'Booking',
            entityId: meta.bookingId,
            metadata: {
              sessionId: obj.id,
              paymentIntentId,
              amountTotal: obj.amount_total,
              currency: obj.currency,
            },
          });

          if (applied) await transactions.record(txRows.jobPaymentStripe({
            booking, sessionId: obj.id, paymentIntentId, amountCents: obj.amount_total, currency: obj.currency,
          }));

          if (applied) logger.info(
              `Booking ${meta.bookingId} marked PAID via Checkout Session ${obj.id} (amount=${obj.amount_total})`
          );
        }
      } else if (meta.purpose === 'deposit' && meta.bookingId) {
        const booking = await prisma.booking.findUnique({ where: { id: meta.bookingId } });
        if (booking && !booking.depositPaidAt && (await accountMatchesBooking(event, booking))) {
          const paymentIntentId =
              typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id || null;

          const depositApplied = await updateBookingOnce({
            where: { id: meta.bookingId, depositPaidAt: null },
            data: {
              depositPaidAt: new Date(),
              depositRequiredCents: obj.amount_total ?? booking.depositRequiredCents,
              stripeDepositSessionId: obj.id,
              stripeDepositPaymentIntentId: paymentIntentId,
              paymentStatus: booking.paymentStatus === 'UNPAID' ? 'DEPOSIT_PAID' : booking.paymentStatus,
            },
          });

          if (depositApplied) await audit({
            businessId: meta.businessId || booking.businessId,
            actorUserId: null,
            action: 'BOOKING_DEPOSIT_RECEIVED',
            entityType: 'Booking',
            entityId: meta.bookingId,
            metadata: { sessionId: obj.id, paymentIntentId, amountTotal: obj.amount_total },
          });

          if (depositApplied) await transactions.record(txRows.deposit({
            booking, sessionId: obj.id, paymentIntentId, amountCents: obj.amount_total ?? booking.depositRequiredCents, currency: obj.currency,
          }));
        }
      } else if (meta.purpose === 'tip' && meta.bookingId) {
        const booking = await prisma.booking.findUnique({ where: { id: meta.bookingId } });
        if (booking && !booking.tipPaidAt && (await accountMatchesBooking(event, booking))) {
          const paymentIntentId =
              typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id || null;

          const tipApplied = await updateBookingOnce({
            where: { id: meta.bookingId, tipPaidAt: null },
            data: {
              tipPaidAt: new Date(),
              tipAmountCents: obj.amount_total ?? 0,
              stripeTipSessionId: obj.id,
              stripeTipPaymentIntentId: paymentIntentId,
            },
          });

          if (tipApplied) await audit({
            businessId: meta.businessId || booking.businessId,
            actorUserId: null,
            action: 'BOOKING_TIP_RECEIVED',
            entityType: 'Booking',
            entityId: meta.bookingId,
            metadata: { sessionId: obj.id, paymentIntentId, amountTotal: obj.amount_total },
          });

          if (tipApplied) await transactions.record(txRows.tip({
            booking, sessionId: obj.id, paymentIntentId, amountCents: obj.amount_total ?? 0, currency: obj.currency,
          }));
        } else if (
          booking &&
          booking.tipPaidAt &&
          booking.stripeTipSessionId !== obj.id &&
          (await accountMatchesBooking(event, booking))
        ) {
          // A tip was already recorded from a different session: this payment is a duplicate.
          await refundDuplicateTip(event, booking, obj);
        }
      }
    } else if (type === 'checkout.session.expired') {
      // An unpaid deposit session ran out: release the slot it was holding.
      // Only a still-REQUESTED, unpaid booking is cancelled - if staff already
      // confirmed it by hand, that decision stands.
      const meta = obj.metadata || {};
      if (meta.purpose === 'deposit' && meta.bookingId) {
        const booking = await prisma.booking.findUnique({ where: { id: meta.bookingId } });
        if (
          booking &&
          booking.stripeDepositSessionId === obj.id &&
          !booking.depositPaidAt &&
          booking.status === 'REQUESTED' &&
          (await accountMatchesBooking(event, booking))
        ) {
          const bookingsService = require('../bookings/bookings.service');
          await bookingsService.cancelBooking(booking.businessId, booking.id, null, 'Deposit was not paid in time', { waiveFee: true });
          logger.info('Cancelled booking after its deposit session expired', { bookingId: booking.id, sessionId: obj.id });
        }
      }
    } else if (type === 'charge.dispute.created' || type === 'charge.dispute.closed') {
      // With direct charges the dispute belongs to the business's Stripe
      // account; Tod Cleaning Services' job is to make sure the business notices and that
      // the cleaner's not-yet-paid earning for the job is put on hold.
      const pi = paymentIntentIdOf(obj.payment_intent);
      const booking = pi
        ? await prisma.booking.findFirst({
            where: { OR: [{ stripePaymentIntentId: pi }, { stripeDepositPaymentIntentId: pi }, { stripeTipPaymentIntentId: pi }] },
          })
        : null;
      if (booking && (await accountMatchesBooking(event, booking))) {
        const opened = type === 'charge.dispute.created';
        const won = !opened && obj.status === 'won';
        if (opened) {
          await prisma.cleanerEarning.updateMany({ where: { bookingId: booking.id, status: 'PENDING' }, data: { status: 'VOIDED' } });
        } else if (won) {
          await prisma.cleanerEarning.updateMany({ where: { bookingId: booking.id, status: 'VOIDED' }, data: { status: 'PENDING' } });
        }
        // Opened = money held (PENDING); closed = lost (money gone) or won (REVERSED).
        await transactions.record(txRows.dispute({
          booking, disputeId: obj.id, paymentIntentId: pi, amountCents: obj.amount, currency: obj.currency, stripeStatus: opened ? 'needs_response' : obj.status,
        }), { updateOnConflict: true });
        await audit({
          businessId: booking.businessId,
          actorUserId: null,
          action: opened ? 'PAYMENT_DISPUTE_OPENED' : 'PAYMENT_DISPUTE_CLOSED',
          entityType: 'Booking',
          entityId: booking.id,
          metadata: {
            disputeId: obj.id,
            amount: obj.amount,
            currency: obj.currency,
            reason: obj.reason,
            status: obj.status,
            evidenceDueBy: obj.evidence_details && obj.evidence_details.due_by ? toDate(obj.evidence_details.due_by) : null,
          },
        });
        try {
          const notifications = require('../notifications/notifications.service');
          await notifications.notifyMembers(
            booking.businessId,
            opened ? 'PAYMENT_DISPUTE_OPENED' : 'PAYMENT_DISPUTE_CLOSED',
            opened ? 'Payment dispute opened' : `Payment dispute ${obj.status}`,
            opened
              ? `A customer disputed the payment for booking ${booking.id}. Respond in your Stripe dashboard before the deadline.`
              : `The dispute on booking ${booking.id} was closed as "${obj.status}".`
          );
        } catch (notifyErr) {
          logger.warn('failed to notify about dispute', { error: notifyErr.message });
        }
      }
    } else if (type === 'refund.created' || type === 'refund.updated') {
      // Refunds a business issues from its own Stripe dashboard never pass through
      // our code, so this is the only way they reach the transaction log. Refunds
      // WE issue (cancellations) use the same dedupe key - the Stripe refund id -
      // so each refund is recorded once, whichever arrives first.
      const pi = paymentIntentIdOf(obj.payment_intent);
      const booking = pi
        ? await prisma.booking.findFirst({
            where: { OR: [{ stripePaymentIntentId: pi }, { stripeDepositPaymentIntentId: pi }, { stripeTipPaymentIntentId: pi }] },
          })
        : null;
      if (booking && obj.amount > 0 && (await accountMatchesBooking(event, booking))) {
        await transactions.record(txRows.refund({
          booking,
          refundId: obj.id,
          paymentIntentId: pi,
          amountCents: obj.amount,
          currency: obj.currency,
          reason: obj.reason,
          status: obj.status === 'failed' || obj.status === 'canceled' ? 'FAILED' : 'SUCCEEDED',
          occurredAt: obj.created ? new Date(obj.created * 1000) : undefined,
        }), { updateOnConflict: true });
      }
    } else if (type === 'account.application.deauthorized') {
      // The business disconnected Tod Cleaning Services from its Stripe account.
      if (event.account) {
        await prisma.business.updateMany({
          where: { stripeConnectedAccountId: event.account },
          data: { stripeChargesEnabled: false, stripePayoutsEnabled: false },
        });
      }
    } else if (type === 'account.updated') {
      // Fires as a connected business completes/updates their Stripe Connect
      // onboarding (KYC, bank details, etc). This is the authoritative way
      // to learn charges_enabled flipped true — don't rely on the frontend
      // redirect alone, since the user can close the tab mid-flow.
      const business = await prisma.business.findFirst({
        where: { stripeConnectedAccountId: obj.id },
      });
      if (business) {
        await prisma.business.update({
          where: { id: business.id },
          data: {
            stripeChargesEnabled: !!obj.charges_enabled,
            stripePayoutsEnabled: !!obj.payouts_enabled,
            stripeConnectOnboarded: !!obj.details_submitted,
          },
        });
      } else {
        // Not a business account, so it is a cleaner's Express account. The
        // user row was never updated from this event before, which left
        // stripePayoutsEnabled false forever unless the app polled for it.
        await prisma.user.updateMany({
          where: { stripeConnectedAccountId: obj.id },
          data: {
            stripePayoutsEnabled: !!obj.payouts_enabled,
            ...(obj.details_submitted ? { stripeConnectOnboardedAt: new Date() } : {}),
          },
        });
      }
    }
  } catch (e) {
    // Answer 500 so Stripe retries. Swallowing the error and returning 200
    // meant a transient DB failure permanently lost the event — a customer
    // could pay and the booking would stay UNPAID.
    logger.error('error handling stripe webhook', { type, eventId: event.id, error: e.message, stack: e.stack });
    return res.status(500).json({ received: false });
  }

  return res.json({ received: true });
}

module.exports = { handle };
