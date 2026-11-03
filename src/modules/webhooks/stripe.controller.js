const { retrieveEvent, retrieveSubscription } = require('../../lib/stripeClient');
const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { audit } = require('../../utils/audit');
const transactions = require('../transactions/transactions.service');
const txRows = require('../transactions/transactions.builders');

/**
 * Stripe subscription status -> our SubscriptionStatus enum. Returns null for
 * states that must not overwrite what we have: `incomplete` means the first
 * payment has not happened yet, and writing an unknown value (the previous
 * code uppercased whatever Stripe sent) made Prisma throw on every retry.
 */
function mapStripeStatus(status) {
  switch (status) {
    case 'trialing':
      return 'TRIALING';
    case 'active':
      return 'ACTIVE';
    case 'past_due':
    case 'unpaid':
      return 'PAST_DUE';
    case 'canceled':
    case 'incomplete_expired':
      return 'CANCELED';
    default:
      return null;
  }
}

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

/** Copies the fields we track from a Stripe subscription object onto our row. */
async function syncSubscriptionRow(where, stripeSub, extra = {}) {
  const data = { ...extra };
  const status = mapStripeStatus(stripeSub.status);
  if (status) data.status = status;
  if (stripeSub.current_period_end) data.currentPeriodEnd = toDate(stripeSub.current_period_end);
  data.trialEndsAt = toDate(stripeSub.trial_end);
  data.canceledAt = stripeSub.cancel_at_period_end ? toDate(stripeSub.canceled_at) || new Date() : status === 'CANCELED' ? new Date() : null;

  // Keep the plan in step when the price was changed in the billing portal.
  const priceId = stripeSub.items && stripeSub.items.data && stripeSub.items.data[0] && stripeSub.items.data[0].price
    ? stripeSub.items.data[0].price.id
    : null;
  if (priceId) {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { stripePriceId: priceId } });
    if (plan) data.planId = plan.id;
  }
  return prisma.businessSubscription.updateMany({ where, data });
}

async function handleSubscriptionCheckoutCompleted(session) {
  const { businessId, planId } = session.metadata || {};
  const stripeSubId = typeof session.subscription === 'string' ? session.subscription : session.subscription && session.subscription.id;
  if (!businessId || !planId || !stripeSubId) return;

  const stripeSub = await retrieveSubscription(stripeSubId);
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer && session.customer.id;
  const status = mapStripeStatus(stripeSub.status) || 'TRIALING';

  await prisma.businessSubscription.upsert({
    where: { businessId },
    create: {
      businessId,
      planId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: stripeSub.id,
      status,
      trialEndsAt: toDate(stripeSub.trial_end),
      currentPeriodEnd: toDate(stripeSub.current_period_end),
    },
    update: {
      planId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: stripeSub.id,
      status,
      trialEndsAt: toDate(stripeSub.trial_end),
      currentPeriodEnd: toDate(stripeSub.current_period_end),
      canceledAt: null,
    },
  });
  await audit({ businessId, action: 'SUBSCRIPTION_STARTED', entityType: 'BusinessSubscription', entityId: businessId, metadata: { planId, status } });
}

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
    if (type === 'invoice.payment_succeeded') {
      const stripeSubId = obj.subscription;
      // An invoice with no subscription (a one-off invoice) has nothing to do
      // with plan billing. Prisma treats an undefined filter as "match
      // anything", so without this guard the first subscription row in the
      // table could be flipped to ACTIVE.
      const subscription = !stripeSubId ? null : await prisma.businessSubscription.findFirst({
        where: { stripeSubscriptionId: stripeSubId },
      });
      if (subscription) {
        await prisma.businessSubscription.update({
          where: { id: subscription.id },
          data: {
            status: 'ACTIVE',
            currentPeriodEnd: new Date(obj.lines.data[0].period.end * 1000),
          },
        });
        // Keep a billing-history record for the business — previously this
        // model was defined in the schema but nothing ever wrote to it, so
        // businesses had no invoice history for what they pay Lady Greener.
        const paidInvoice = await prisma.platformInvoice.upsert({
          where: { stripeInvoiceId: obj.id },
          create: {
            subscriptionId: subscription.id,
            stripeInvoiceId: obj.id,
            amountCents: obj.amount_paid,
            status: 'paid',
            issuedAt: new Date(obj.created * 1000),
            paidAt: new Date(),
          },
          update: { status: 'paid', paidAt: new Date(), amountCents: obj.amount_paid },
        });
        // updateOnConflict: a retried invoice that failed earlier is now SUCCEEDED.
        await transactions.record(txRows.subscriptionInvoice({
          businessId: subscription.businessId,
          platformInvoiceId: paidInvoice && paidInvoice.id,
          invoiceId: obj.id,
          amountCents: obj.amount_paid,
          currency: obj.currency,
          paid: true,
          occurredAt: obj.status_transitions && obj.status_transitions.paid_at ? new Date(obj.status_transitions.paid_at * 1000) : new Date(),
        }), { updateOnConflict: true });
      }
    } else if (type === 'invoice.payment_failed') {
      const stripeSubId = obj.subscription;
      const subscription = !stripeSubId ? null : await prisma.businessSubscription.findFirst({
        where: { stripeSubscriptionId: stripeSubId },
      });
      if (subscription) {
        await prisma.businessSubscription.update({
          where: { id: subscription.id },
          data: { status: 'PAST_DUE' },
        });
        const failedInvoice = await prisma.platformInvoice.upsert({
          where: { stripeInvoiceId: obj.id },
          create: {
            subscriptionId: subscription.id,
            stripeInvoiceId: obj.id,
            amountCents: obj.amount_due,
            status: 'open',
            issuedAt: new Date(obj.created * 1000),
          },
          update: { status: 'open' },
        });
        // No updateOnConflict: a late "failed" event must never downgrade an invoice that has since been paid.
        await transactions.record(txRows.subscriptionInvoice({
          businessId: subscription.businessId,
          platformInvoiceId: failedInvoice && failedInvoice.id,
          invoiceId: obj.id,
          amountCents: obj.amount_due,
          currency: obj.currency,
          paid: false,
        }));
      }
    } else if (type === 'customer.subscription.deleted') {
      await prisma.businessSubscription.updateMany({
        where: { stripeSubscriptionId: obj.id },
        data: { status: 'CANCELED', canceledAt: new Date() },
      });
    } else if (type === 'customer.subscription.updated') {
      await syncSubscriptionRow({ stripeSubscriptionId: obj.id }, obj);
    } else if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
      const meta = obj.metadata || {};
      if (obj.mode === 'subscription' || meta.purpose === 'subscription') {
        await handleSubscriptionCheckoutCompleted(obj);
      } else if (obj.payment_status && obj.payment_status !== 'paid') {
        // Asynchronous methods (SEPA debit, some bank redirects) complete the
        // session before the money arrives; checkout.session.async_payment_succeeded
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
      // account; Lady Greener's job is to make sure the business notices and that
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
      // The business disconnected Lady Greener from its Stripe account.
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

module.exports = { handle, mapStripeStatus };
