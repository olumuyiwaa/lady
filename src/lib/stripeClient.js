const Stripe = require('stripe');
const prisma = require('../config/database');
const logger = require('../config/logger');

/**
 * Tod Cleaning Services takes payments on its own Stripe account (no Stripe Connect).
 * The business row stores DIRECT_ACCOUNT in stripeConnectedAccountId so every
 * existing "is Stripe set up?" check keeps working, and this helper turns that
 * marker into "no stripeAccount header" so Stripe uses our own account.
 */
const DIRECT_ACCOUNT = 'direct';
const acct = (id) => (id && id !== DIRECT_ACCOUNT ? { stripeAccount: id } : {});

function defaultCurrency() {
  return (process.env.DEFAULT_CURRENCY || 'eur').toLowerCase();
}

// Payment methods offered at checkout. Job payments are DIRECT charges on the
// business's own connected account, so which methods appear (card, iDEAL, ...)
// is governed by that account's payment-method settings. Leave
// CHECKOUT_PAYMENT_METHODS unset to use Stripe's dynamic payment methods
// (recommended: iDEAL then shows up automatically for EUR when the account has
// it enabled). Set it (comma separated, e.g. "card,ideal") only to force a
// fixed list; EUR-only methods are then dropped for other currencies.
const EUR_ONLY_METHODS = ['ideal', 'bancontact', 'sepa_debit', 'eps', 'p24'];
function checkoutPaymentMethods(currency) {
  const raw = process.env.CHECKOUT_PAYMENT_METHODS;
  if (!raw || !raw.trim()) return undefined;
  const configured = raw.split(',').map((m) => m.trim()).filter(Boolean);
  const isEur = (currency || defaultCurrency()).toLowerCase() === 'eur';
  const methods = isEur ? configured : configured.filter((m) => !EUR_ONLY_METHODS.includes(m));
  return methods.length ? methods : ['card'];
}
const paymentMethodTypes = (currency) => {
  const methods = checkoutPaymentMethods(currency);
  return methods ? { payment_method_types: methods } : {};
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2022-11-15' });

async function createCustomerForBusiness(businessId, { email, phone } = {}) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { members: { where: { role: 'BUSINESS_OWNER' }, take: 1, include: { user: true } } },
  });
  const ownerEmail =
    email ||
    (business && business.members && business.members[0] && business.members[0].user && business.members[0].user.email) ||
    undefined;

  const customer = await stripe.customers.create({ email: ownerEmail, phone });
  return customer.id;
}

async function createSubscription(stripeCustomerId, priceId) {
  const sub = await stripe.subscriptions.create({
    customer: stripeCustomerId,
    items: [{ price: priceId }],
    expand: ['latest_invoice.payment_intent'],
  });
  return sub;
}

async function cancelSubscription(stripeSubscriptionId) {
  return stripe.subscriptions.cancel(stripeSubscriptionId);
}

function appUrl() {
  return process.env.APP_URL || 'http://localhost:3000';
}

/**
 * Hosted Checkout for the platform's own subscription billing (Tod Cleaning Services ->
 * business). This is how a payment method gets attached: creating a Stripe
 * subscription server-side for a customer with no payment method leaves it
 * `incomplete` forever, so the subscription must be started through Checkout.
 *
 * - payment_method_collection 'always' so a trial converts without a second
 *   trip to the customer.
 * - tax_id_collection lets Dutch/EU businesses supply a BTW number, which is
 *   what makes reverse-charge invoicing possible.
 * - STRIPE_AUTOMATIC_TAX=true turns on Stripe Tax for the platform invoice.
 */
async function createSubscriptionCheckoutSession({
  businessId,
  planId,
  priceId,
  stripeCustomerId,
  customerEmail,
  trialDays,
  successUrl,
  cancelUrl,
}) {
  if (!process.env.STRIPE_SECRET_KEY) {
    const err = new Error('STRIPE_SECRET_KEY is not configured');
    err.status = 503;
    throw err;
  }
  const trial = Number.isFinite(trialDays) && trialDays > 0 ? trialDays : undefined;

  return stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    payment_method_collection: 'always',
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    ...(process.env.STRIPE_AUTOMATIC_TAX === 'true' ? { automatic_tax: { enabled: true } } : {}),
    ...(stripeCustomerId
      ? { customer: stripeCustomerId, customer_update: { address: 'auto', name: 'auto' } }
      : { customer_email: customerEmail || undefined }),
    subscription_data: {
      ...(trial ? { trial_period_days: trial } : {}),
      metadata: { businessId, planId },
    },
    metadata: { purpose: 'subscription', businessId, planId },
    success_url: successUrl || `${appUrl()}/subscription?checkout=success`,
    cancel_url: cancelUrl || `${appUrl()}/subscription?checkout=cancelled`,
  });
}

/** Moves an existing subscription to another price, prorating the difference. */
async function changeSubscriptionPlan(stripeSubscriptionId, priceId) {
  const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const item = sub.items && sub.items.data && sub.items.data[0];
  if (!item) {
    const err = new Error('Stripe subscription has no items to change');
    err.status = 409;
    throw err;
  }
  return stripe.subscriptions.update(stripeSubscriptionId, {
    items: [{ id: item.id, price: priceId }],
    proration_behavior: 'create_prorations',
    cancel_at_period_end: false,
  });
}

/** Ends the subscription at the close of the paid period — matches the "cancel anytime, effective at period end" promise on the pricing page. */
async function cancelSubscriptionAtPeriodEnd(stripeSubscriptionId) {
  return stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });
}

async function retrieveSubscription(stripeSubscriptionId) {
  return stripe.subscriptions.retrieve(stripeSubscriptionId);
}

/** Stripe-hosted page where the business updates its card/SEPA mandate and downloads invoices. */
async function createBillingPortalSession(stripeCustomerId, returnUrl) {
  return stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl || `${appUrl()}/subscription`,
  });
}

/**
 * Stripe issues a separate signing secret per webhook endpoint, and events for
 * connected accounts (account.updated, and every direct-charge event) arrive on
 * a "Connect" endpoint while platform events arrive on an "Account" endpoint.
 * List every secret in STRIPE_WEBHOOK_SECRETS (comma separated); the legacy
 * single STRIPE_WEBHOOK_SECRET is still honoured. An event is accepted if any
 * of them verifies it.
 */
function webhookSecrets() {
  return [process.env.STRIPE_WEBHOOK_SECRETS, process.env.STRIPE_WEBHOOK_SECRET]
    .filter(Boolean)
    .join(',')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

async function retrieveEvent(rawBody, sig) {
  const secrets = webhookSecrets();
  if (secrets.length === 0) return null;
  let lastErr;
  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(rawBody, sig, secret);
    } catch (err) {
      lastErr = err;
    }
  }
  logger.error('stripe webhook verification failed', { message: lastErr && lastErr.message });
  throw lastErr;
}

/**
 * Platform fee on each job-level payment, in basis points (150 = 1.5%).
 * Tod Cleaning Services keeps the full payment, so this must stay 0: server.js refuses
 * to start when PLATFORM_APPLICATION_FEE_BPS is non-zero. Kept (rather than
 * removed) so the checkout/refund code paths that read it need no change.
 */
function getApplicationFeeBps() {
  const raw = process.env.PLATFORM_APPLICATION_FEE_BPS;
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Creates a Stripe Connect Express account for a business and returns an
 * onboarding link. Express accounts push most compliance/KYC UI onto
 * Stripe's hosted flow, which is the right tradeoff for a platform this
 * size — we don't want to own identity verification.
 */
async function createConnectAccountAndLink(business, { refreshUrl, returnUrl }) {
  let accountId = business.stripeConnectedAccountId;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      // business_type is intentionally not set: many small cleaning
      // businesses are sole proprietors (individual), and forcing 'company'
      // pushes them through the wrong verification. Stripe's hosted
      // onboarding asks. PLATFORM_COUNTRY (ISO code, e.g. NL) sets the
      // account country; when unset Stripe uses the platform's country.
      ...(process.env.PLATFORM_COUNTRY ? { country: process.env.PLATFORM_COUNTRY } : {}),
      business_profile: {
        name: business.name,
        url: business.customDomain ? `https://${business.customDomain}` : undefined,
      },
      metadata: { businessId: business.id },
    });
    accountId = account.id;
    await prisma.business.update({
      where: { id: business.id },
      data: { stripeConnectedAccountId: accountId },
    });
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl || `${process.env.APP_URL || 'http://localhost:3000'}/business-settings?stripe=refresh`,
    return_url: returnUrl || `${process.env.APP_URL || 'http://localhost:3000'}/business-settings?stripe=return`,
    type: 'account_onboarding',
  });

  return { accountId, url: link.url };
}

/** Pulls current charges_enabled/payouts_enabled/details_submitted from Stripe for a connected account. */
async function getConnectAccountStatus(accountId) {
  const account = await stripe.accounts.retrieve(accountId);
  return {
    chargesEnabled: !!account.charges_enabled,
    payoutsEnabled: !!account.payouts_enabled,
    detailsSubmitted: !!account.details_submitted,
  };
}

/**
 * Creates a Stripe Connect Express account for a cleaner and returns an
 * onboarding link. Mirrors createConnectAccountAndLink for businesses, with
 * two differences: it's stored on User.stripeConnectedAccountId (a person-
 * level identity — a cleaner working for two businesses shouldn't have to
 * onboard twice, see the schema comment on User), and business_type is
 * 'individual' rather than 'company' since a cleaner is onboarding as
 * themselves, not as a registered business.
 */
async function createCleanerConnectAccountAndLink(user, { refreshUrl, returnUrl } = {}) {
  let accountId = user.stripeConnectedAccountId;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      business_type: 'individual',
      email: user.email,
      individual: {
        email: user.email,
        first_name: user.firstName,
        last_name: user.lastName,
      },
      metadata: { userId: user.id },
    });
    accountId = account.id;
    await prisma.user.update({
      where: { id: user.id },
      data: { stripeConnectedAccountId: accountId },
    });
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl || `${process.env.APP_URL || 'http://localhost:3000'}/cleaner/earnings?stripe=refresh`,
    return_url: returnUrl || `${process.env.APP_URL || 'http://localhost:3000'}/cleaner/earnings?stripe=return`,
    type: 'account_onboarding',
  });

  return { accountId, url: link.url };
}

/**
 * Pays out a cleaner by transferring funds from the *business's* Stripe
 * Connect balance to the cleaner's own connected account.
 *
 * This is deliberately not a transfer from the platform's own balance.
 * Job payments are direct charges on the business's connected account
 * (see createDirectCheckoutSession) — Tod Cleaning Services'
 * platform account only ever holds the optional application fee, so it has
 * no cleaner-payroll funds to move. Passing { stripeAccount:
 * businessConnectedAccountId } makes Stripe create the Transfer as that
 * connected account, moving money out of *its* balance to the cleaner's
 * connected account — the same "platform-facilitated, connected-account-
 * funded" pattern used for marketplaces paying sub-recipients.
 *
 * NOTE: unverified. Stripe may only allow the platform to create Transfers to
 * connected accounts; payroll.service gates this behind
 * ENABLE_STRIPE_CLEANER_PAYOUTS until it is proven in test mode.
 *
 * Throws a 402 if the business's connected balance can't cover it (Stripe's
 * balance_insufficient), so the caller can surface "insufficient balance,
 * try again once more job payments have settled" instead of a generic 500.
 */
async function payCleanerTransfer({
  businessConnectedAccountId,
  cleanerConnectedAccountId,
  amountCents,
  currency = defaultCurrency(),
  payoutId,
  description,
}) {
  if (!process.env.STRIPE_SECRET_KEY) {
    const err = new Error('STRIPE_SECRET_KEY is not configured');
    err.status = 503;
    throw err;
  }
  if (!businessConnectedAccountId) {
    const err = new Error('Business has not completed Stripe Connect onboarding');
    err.status = 402;
    throw err;
  }
  if (!cleanerConnectedAccountId) {
    const err = new Error('Cleaner has not completed Stripe Connect onboarding');
    err.status = 402;
    throw err;
  }
  if (!amountCents || amountCents < 1) {
    const err = new Error('Amount must be greater than 0');
    err.status = 422;
    throw err;
  }

  try {
    const transfer = await stripe.transfers.create(
      {
        amount: amountCents,
        currency: (currency || defaultCurrency()).toLowerCase(),
        destination: cleanerConnectedAccountId,
        description: description || `Cleaner payout ${payoutId || ''}`.trim(),
        metadata: { payoutId: payoutId || '' },
      },
      {
        ...acct(businessConnectedAccountId),
        // A double click or a retry must not pay the cleaner twice.
        ...(payoutId ? { idempotencyKey: `payout_${payoutId}` } : {}),
      }
    );
    return transfer;
  } catch (err) {
    if (err && err.code === 'balance_insufficient') {
      const wrapped = new Error('Business Stripe balance is insufficient to cover this payout yet');
      wrapped.status = 402;
      throw wrapped;
    }
    throw err;
  }
}

/**
 * Creates a one-time Checkout Session as a DIRECT charge on the business's own
 * connected account: the business is the merchant of record, the payment (and
 * any dispute or refund) lives on its account, it pays Stripe's fees, and the
 * money never sits in Tod Cleaning Services' balance. Tod Cleaning Services only ever collects
 * application_fee_amount, which is 0 by default (see PLATFORM_APPLICATION_FEE_BPS).
 *
 * This replaces destination charges (transfer_data.destination), under which the
 * platform was the merchant of record, carried disputes and paid the processing
 * fees - while the pricing page promises a 0% fee and that money never routes
 * through Tod Cleaning Services.
 *
 * metadata.bookingId / purpose are read back by the webhook to mark the booking
 * paid; events for these sessions arrive with event.account set.
 */
async function createDirectCheckoutSession({
  purpose,
  bookingId,
  businessId,
  connectedAccountId,
  amountCents,
  currency = defaultCurrency(),
  customerEmail,
  successUrl,
  cancelUrl,
  description,
  applyPlatformFee = true,
  expiresInMinutes,
}) {
  if (!process.env.STRIPE_SECRET_KEY) {
    const err = new Error('STRIPE_SECRET_KEY is not configured');
    err.status = 503;
    throw err;
  }
  if (!connectedAccountId) {
    const err = new Error('Business has not completed Stripe Connect onboarding');
    err.status = 402;
    throw err;
  }
  if (!amountCents || amountCents < 50) {
    const err = new Error('Amount must be at least 50 minor units');
    err.status = 422;
    throw err;
  }

  const applicationFeeAmount = applyPlatformFee ? Math.floor((amountCents * getApplicationFeeBps()) / 10000) : 0;
  const base = process.env.APP_URL || 'http://localhost:3000';

  return stripe.checkout.sessions.create(
    {
      mode: 'payment',
      ...paymentMethodTypes(currency),
      line_items: [
        {
          price_data: {
            currency: (currency || defaultCurrency()).toLowerCase(),
            product_data: { name: description || `Cleaning ${purpose} ${bookingId}` },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      // Save the payment method from this Checkout for later off-session
      // charges (see chargeSavedPaymentMethod below). Without this, every
      // recurring job needs the customer to redirect through iDEAL/Checkout
      // again — iDEAL itself has no recurring-charge mode.
      payment_intent_data: {
        setup_future_usage: 'off_session',
        // Omit entirely when 0 so a 0%-fee deployment never sends application_fee_amount: 0.
        ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
      },
      customer_email: customerEmail || undefined,
      success_url: successUrl || `${base}/portal?payment=success&bookingId=${bookingId}`,
      cancel_url: cancelUrl || `${base}/portal?payment=cancelled&bookingId=${bookingId}`,
      ...(expiresInMinutes ? { expires_at: Math.floor(Date.now() / 1000) + Math.round(expiresInMinutes * 60) } : {}),
      metadata: { bookingId, businessId, purpose },
    },
    acct(connectedAccountId)
  );
}

/**
 * Charges a customer's saved payment method for a recurring job, with no
 * redirect. On an SCA challenge (common in the EU under PSD2) Stripe
 * throws `authentication_required` instead of succeeding — that's not a
 * failure to surface as an error, it's a signal for the caller to fall
 * back to emailing a payment link (createBookingCheckoutSession) so the
 * customer can complete the challenge themselves.
 */
async function chargeSavedPaymentMethod({
  connectedAccountId,
  stripeCustomerId,
  paymentMethodId,
  amountCents,
  currency = defaultCurrency(),
  bookingId,
  businessId,
  applyPlatformFee = true,
}) {
  if (!connectedAccountId || !stripeCustomerId || !paymentMethodId) {
    const err = new Error('Missing saved payment method for off-session charge');
    err.status = 402;
    throw err;
  }
  const applicationFeeAmount = applyPlatformFee ? Math.floor((amountCents * getApplicationFeeBps()) / 10000) : 0;
  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: (currency || defaultCurrency()).toLowerCase(),
        customer: stripeCustomerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        ...(applicationFeeAmount > 0 ? { application_fee_amount: applicationFeeAmount } : {}),
        metadata: { bookingId, businessId, purpose: 'recurring_job_payment' },
      },
      acct(connectedAccountId)
    );
    return { paymentIntent: intent, requiresAction: false };
  } catch (err) {
    if (err.code === 'authentication_required') {
      return { paymentIntent: err.raw?.payment_intent || null, requiresAction: true };
    }
    throw err;
  }
}

/** Checkout Session for the job payment itself (or the balance still owed). */
async function createBookingCheckoutSession(args) {
  return createDirectCheckoutSession({ ...args, purpose: 'job_payment', description: args.description || `Cleaning booking ${args.bookingId}` });
}

/** Deposit taken at booking time, or a post-completion tip. */
async function createAncillaryCheckoutSession(args) {
  return createDirectCheckoutSession(args);
}

/**
 * Expires an unpaid Checkout Session so a cancelled booking's payment link
 * cannot be paid afterwards. Best effort: an already-completed or expired
 * session is not an error.
 */
async function expireCheckoutSession(sessionId, connectedAccountId) {
  if (!sessionId || !connectedAccountId) return null;
  try {
    return await stripe.checkout.sessions.expire(sessionId, {}, acct(connectedAccountId));
  } catch (err) {
    logger.warn('could not expire checkout session', { sessionId, error: err.message });
    return null;
  }
}

/**
 * Refunds a prior charge, fully (amountCents omitted) or partially. Returns
 * null when there is no payment intent to refund against.
 *
 * Pass connectedAccountId for direct charges (the normal case now): the refund
 * is created on the business's account. Without it the legacy destination-charge
 * behaviour applies (reverse_transfer), which is only correct for payments made
 * before the switch to direct charges.
 */
async function createRefund({ paymentIntentId, amountCents, reason, connectedAccountId, idempotencyKey }) {
  if (!paymentIntentId) return null;
  const params = {
    payment_intent: paymentIntentId,
    ...(amountCents != null ? { amount: amountCents } : {}),
    reason: reason || 'requested_by_customer',
  };
  const opts = {
    ...(connectedAccountId ? acct(connectedAccountId) : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  if (!connectedAccountId) params.reverse_transfer = true;
  if (getApplicationFeeBps() > 0) params.refund_application_fee = true;
  return stripe.refunds.create(params, opts);
}

module.exports = {
  DIRECT_ACCOUNT,
  createCustomerForBusiness,
  createSubscription,
  cancelSubscription,
  createSubscriptionCheckoutSession,
  changeSubscriptionPlan,
  cancelSubscriptionAtPeriodEnd,
  retrieveSubscription,
  createBillingPortalSession,
  retrieveEvent,
  createConnectAccountAndLink,
  getConnectAccountStatus,
  createCleanerConnectAccountAndLink,
  payCleanerTransfer,
  createBookingCheckoutSession,
  createAncillaryCheckoutSession,
  chargeSavedPaymentMethod,
  expireCheckoutSession,
  createRefund,
  webhookSecrets,
  stripe,
};
