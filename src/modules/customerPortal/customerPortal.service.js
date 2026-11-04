/**
 * Lightweight customer self-service portal.
 * Access is phone OR email + one-time code (OTP stored in OtpCode with purpose CUSTOMER_PORTAL).
 * An email login sends the code by email only, so it costs no SMS.
 * All actions are scoped to a single business resolved from the Host header (widget style).
 */
const crypto = require('crypto');
const prisma = require('../../config/database');
const notificationClient = require('../../lib/notificationClient');
const logger = require('../../config/logger');
const { createAncillaryCheckoutSession } = require('../../lib/stripeClient');
const { findCustomerByPhone } = require('../../lib/phone');
const { buildTimeline } = require('../../lib/bookingTimeline');
const { REFERRAL_DISCOUNT_CENTS, REFERRAL_REWARD_CENTS } = require('../../lib/referral');

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_REQUESTS_PER_WINDOW = 3;
const OTP_MAX_FAILED_ATTEMPTS = 5;
const PORTAL_TOKEN_TTL = process.env.PORTAL_TOKEN_EXPIRY || '24h';

const PURPOSE_CODE = 'CUSTOMER_PORTAL';
// Failed guesses are recorded as rows of their own so they can be counted per
// portal identity across server instances without a schema change.
const PURPOSE_FAILED = 'CUSTOMER_PORTAL_FAILED';

function tooMany(message) {
  const err = new Error(message);
  err.status = 429;
  return err;
}

/**
 * Each portal customer gets a dedicated identity row that can never hold a
 * membership or a cleaner profile. The previous implementation attached the
 * OTP to whichever User had the same phone number — which could be a business
 * owner or cleaner — and then signed a token for that user, so a portal login
 * could be turned into a staff session.
 */
function portalEmailFor(customerId) {
  return `portal-${customerId}@portal.invalid`;
}

async function findOrCreatePortalUser(customer) {
  const email = portalEmailFor(customer.id);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  const bcrypt = require('bcryptjs');
  return prisma.user.create({
    data: {
      email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      isActive: true,
    },
  });
}

const { generateNumericCode, hashOtp: hashCode } = require('../../lib/otp');

function normalizeEmail(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Resolves who is asking for access. A phone number takes precedence (the
 * original behaviour); otherwise the email is used. Phone matches however the
 * number was typed or stored (see lib/phone.js); email is case-insensitive.
 *
 * If several customers of one business share an email (a parent booking for
 * two households, say) the oldest record is used: the code only ever goes to
 * that address, so this can never expose a record to someone who does not
 * control the mailbox.
 */
async function findPortalCustomer(businessId, { phone, email }) {
  if (typeof phone === 'string' && phone.trim()) {
    return { customer: await findCustomerByPhone(prisma, businessId, phone), viaEmail: false };
  }
  const address = normalizeEmail(email);
  if (!address) return { customer: null, viaEmail: false };
  const customer = await prisma.customer.findFirst({
    where: { businessId, email: { equals: address, mode: 'insensitive' } },
    orderBy: { createdAt: 'asc' },
  });
  return { customer, viaEmail: true };
}

async function requestAccess(businessId, { phone, email } = {}) {
  const { customer, viaEmail } = await findPortalCustomer(businessId, { phone, email });
  if (!customer) {
    // Do not leak existence — still return success shape
    return { sent: true };
  }

  const user = await findOrCreatePortalUser(customer);
  const since = new Date(Date.now() - OTP_TTL_MS);

  // Cap how many codes can be requested per window (SMS-bombing / cost abuse).
  // Answer with the normal success shape so the cap does not reveal anything.
  const recent = await prisma.otpCode.count({
    where: { userId: user.id, purpose: PURPOSE_CODE, createdAt: { gte: since } },
  });
  if (recent >= OTP_MAX_REQUESTS_PER_WINDOW) return { sent: true };

  // Only the newest code is ever valid.
  await prisma.otpCode.updateMany({
    where: { userId: user.id, purpose: PURPOSE_CODE, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const code = generateNumericCode();
  if (process.env.NODE_ENV !== 'production') {
    const who = viaEmail ? email : phone;
    logger.info(`[DEV] Portal OTP for ${who}: ${code}`);
    console.log(`[DEV] Portal OTP for ${who}: ${code}`);
  }
  await prisma.otpCode.create({
    data: {
      userId: user.id,
      code: hashCode(user.id, code),
      purpose: PURPOSE_CODE,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  const text = `Your Tod Cleaning Services access code is ${code}. It expires in 10 minutes.`;
  try {
    // An email login never triggers an SMS: the customer chose email, and SMS costs money.
    if (!viaEmail && customer.phone) await notificationClient.sendSms({ to: customer.phone, body: text });
    if (customer.email) await notificationClient.sendEmail({ to: customer.email, subject: 'Your access code', text });
  } catch (e) {
    logger.error('failed to send portal OTP', e);
  }

  return { sent: true };
}

async function verifyAccess(businessId, { phone, email, code }) {
  const invalid = () => {
    const err = new Error('Invalid or expired code');
    err.status = 401;
    return err;
  };

  const { customer } = await findPortalCustomer(businessId, { phone, email });
  if (!customer) throw invalid();

  const user = await prisma.user.findUnique({ where: { email: portalEmailFor(customer.id) } });
  if (!user) throw invalid();

  const since = new Date(Date.now() - OTP_TTL_MS);
  const failures = await prisma.otpCode.count({
    where: { userId: user.id, purpose: PURPOSE_FAILED, createdAt: { gte: since } },
  });
  if (failures >= OTP_MAX_FAILED_ATTEMPTS) {
    // Burn any outstanding code: after too many wrong guesses the customer
    // has to request a fresh one, which is itself rate limited.
    await prisma.otpCode.updateMany({
      where: { userId: user.id, purpose: PURPOSE_CODE, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    throw tooMany('Too many incorrect codes. Request a new code and try again.');
  }

  const otp = await prisma.otpCode.findFirst({
    where: {
      userId: user.id,
      purpose: PURPOSE_CODE,
      code: hashCode(user.id, String(code)),
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) {
    await prisma.otpCode.create({
      data: { userId: user.id, code: 'x', purpose: PURPOSE_FAILED, expiresAt: new Date(Date.now() + OTP_TTL_MS) },
    });
    throw invalid();
  }
  await prisma.otpCode.updateMany({
    where: { userId: user.id, purpose: { in: [PURPOSE_CODE, PURPOSE_FAILED] }, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  // The audience marks this as a customer-portal token. authenticate()
  // rejects any token that carries one, so it can never act as a staff or
  // cleaner session even though it shares the signing secret.
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { sub: user.id, businessId, portalCustomerId: customer.id, scope: 'CUSTOMER_PORTAL' },
    process.env.JWT_SECRET,
    { expiresIn: PORTAL_TOKEN_TTL, audience: 'customer-portal' }
  );

  return {
    token,
    customer: {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
    },
  };
}

async function listMyBookings(businessId, customerId) {
  return prisma.booking.findMany({
    where: { businessId, customerId },
    include: { service: true, review: true, assignments: { include: { cleaner: { include: { user: { select: { firstName: true, lastName: true } } } } } } },
    orderBy: { scheduledStart: 'desc' },
    take: 100,
  });
}

/**
 * Cheap ownership-checked lookup for write paths (cancel, reschedule, tip,
 * review). They only need the row itself, so they must not pay for assignments,
 * checklist and photo-URL signing the way the detail view does.
 */
async function findMyBooking(businessId, customerId, bookingId) {
  const b = await prisma.booking.findFirst({
    where: { id: bookingId, businessId, customerId },
    include: { service: true, review: true },
  });
  if (!b) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  return b;
}

async function getMyBooking(businessId, customerId, bookingId) {
  const b = await prisma.booking.findFirst({
    where: { id: bookingId, businessId, customerId },
    include: {
      service: true,
      checklist: true,
      photos: true,
      review: true,
      assignments: { include: { cleaner: { include: { user: { select: { firstName: true, lastName: true } } } } } },
    },
  });
  if (!b) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  // Photo rows only hold private storage keys; hand the customer short-lived
  // signed URLs so the portal can show before/after photos.
  const { getSignedDownloadUrl } = require('../../config/storage');
  const photos = await Promise.all(
    (b.photos || []).map(async (ph) => {
      try {
        return { ...ph, url: await getSignedDownloadUrl(ph.storageKey) };
      } catch (e) {
        return { ...ph, url: null };
      }
    })
  );
  const confirmedAt = await findConfirmedAt(businessId, bookingId);
  return {
    ...b,
    photos,
    timeline: buildTimeline(b, b.assignments, { confirmedAt }),
  };
}

/** When staff confirmed the booking, from the audit log (null if never recorded). */
async function findConfirmedAt(businessId, bookingId) {
  try {
    const row = await prisma.auditLog.findFirst({
      where: { businessId, entityType: 'Booking', entityId: bookingId, action: 'BOOKING_CONFIRMED' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    return row ? row.createdAt : null;
  } catch (e) {
    return null;
  }
}

/** Light-weight progress timeline, for live refresh while a visit is under way. */
async function getMyTimeline(businessId, customerId, bookingId) {
  const b = await prisma.booking.findFirst({
    where: { id: bookingId, businessId, customerId },
    include: { assignments: true },
  });
  if (!b) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  const confirmedAt = await findConfirmedAt(businessId, bookingId);
  return { status: b.status, ...buildTimeline(b, b.assignments, { confirmedAt }) };
}

/**
 * Customer self-service cancellation. Unlike the old hardcoded "must be
 * >12h out or reject outright" rule, this always allows the cancellation
 * (a customer who genuinely can't make it should be able to cancel any
 * time) and instead applies the business's cancellation-fee policy — a
 * late cancellation costs money rather than being blocked. A business that
 * hasn't configured a policy still allows free cancellation at any time.
 */
async function cancelMyBooking(businessId, customerId, bookingId, reason) {
  const b = await findMyBooking(businessId, customerId, bookingId);
  if (['COMPLETED', 'CANCELLED', 'IN_PROGRESS'].includes(b.status)) {
    const err = new Error(`Cannot cancel a booking that is ${b.status}`);
    err.status = 422;
    throw err;
  }

  // Delegate to the same path staff use. The portal used to carry its own
  // copy that refunded a single PaymentIntent, never gave back gift card value
  // or coupon redemptions, and — because it skipped the notifications — left
  // the business and the assigned cleaner unaware the job was cancelled.
  return require('../bookings/bookings.service').cancelBooking(
    businessId,
    bookingId,
    null,
    reason || 'Cancelled by customer'
  );
}

/**
 * Customer-initiated tip on a completed booking. Creates a Checkout Session
 * for the tip amount, settled to the business's connected account with no
 * platform application fee (the platform's 1.5% is meant to come out of the
 * job charge, not out of a cleaner's tip).
 */
// Upper bound on a single tip (minor units). Stops a typo or a hostile client
// from creating a Checkout Session for an absurd amount on a business's account.
const MAX_TIP_CENTS = 50000;

async function tipMyBooking(businessId, customerId, bookingId, { amountCents, successUrl, cancelUrl }) {
  const b = await findMyBooking(businessId, customerId, bookingId);
  if (b.status !== 'COMPLETED') {
    const err = new Error('You can only tip on a completed booking');
    err.status = 422;
    throw err;
  }
  // One tip per booking. The webhook records a single paid tip and ignores any
  // later one, so a second session would charge the customer for nothing.
  if (b.tipPaidAt) {
    const err = new Error('A tip has already been paid for this booking');
    err.status = 409;
    throw err;
  }
  if (!Number.isInteger(amountCents) || amountCents < 50) {
    const err = new Error('Tip amount must be at least 50 minor units');
    err.status = 422;
    throw err;
  }
  if (amountCents > MAX_TIP_CENTS) {
    const err = new Error('Tip amount is too large');
    err.status = 422;
    throw err;
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { stripeConnectedAccountId: true, stripeChargesEnabled: true, currency: true },
  });
  if (!business?.stripeChargesEnabled || !business?.stripeConnectedAccountId) {
    const err = new Error('This business cannot accept card payments yet');
    err.status = 402;
    throw err;
  }

  const session = await createAncillaryCheckoutSession({
    purpose: 'tip',
    bookingId,
    businessId,
    connectedAccountId: business.stripeConnectedAccountId,
    amountCents,
    currency: business.currency,
    successUrl,
    cancelUrl,
    description: `Tip for booking ${bookingId}`,
    applyPlatformFee: false,
  });

  await prisma.booking.update({
    where: { id: bookingId },
    data: { stripeTipSessionId: session.id },
  });

  return { url: session.url, sessionId: session.id };
}

async function rescheduleMyBooking(businessId, customerId, bookingId, { scheduledStart }) {
  const b = await findMyBooking(businessId, customerId, bookingId);
  if (['COMPLETED', 'CANCELLED', 'IN_PROGRESS'].includes(b.status)) {
    const err = new Error(`Cannot reschedule a booking that is ${b.status}`);
    err.status = 422;
    throw err;
  }
  const start = new Date(scheduledStart);
  if (Number.isNaN(start.getTime()) || start < new Date()) {
    const err = new Error('scheduledStart must be a future datetime');
    err.status = 422;
    throw err;
  }
  const durationMs = new Date(b.scheduledEnd) - new Date(b.scheduledStart);
  const end = new Date(start.getTime() + (durationMs > 0 ? durationMs : 3600000));

  // Same rules as booking through the widget. The portal used to look only at
  // "is any cleaner free", ignoring opening hours and the unassigned bookings
  // already holding the slot - so it could oversell exactly what the widget
  // now protects.
  const { assertWithinBusinessHours } = require('../../lib/businessHours');
  const { spareCapacity } = require('../../lib/capacity');
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } });
  await assertWithinBusinessHours(businessId, start, end, (biz && biz.timezone) || 'Europe/Amsterdam');

  const { withBusinessLock } = require('../../lib/bookingLock');
  const { assertCleanerFree } = require('../../lib/assignmentConflicts');

  const updated = await withBusinessLock(businessId, async (tx) => {
    const { spare } = await spareCapacity(businessId, start, end, { lat: b.latitude, lng: b.longitude, excludeBookingId: bookingId });
    if (spare < 1) {
      const err = new Error('No availability at the requested time');
      err.status = 422;
      throw err;
    }

    // Keep the assigned cleaner(s) only if they are free at the new time;
    // otherwise release them (the business re-dispatches). Rescheduling
    // previously flipped ASSIGNED -> CONFIRMED but left the cleaner attached.
    const assignments = await tx.bookingAssignment.findMany({ where: { bookingId } });
    let released = false;
    for (const a of assignments) {
      try {
        await assertCleanerFree(a.cleanerId, start, end, { excludeBookingId: bookingId });
      } catch (e) {
        released = true;
        break;
      }
    }
    if (released) await tx.bookingAssignment.deleteMany({ where: { bookingId } });

    return tx.booking.update({
      where: { id: bookingId },
      data: {
        scheduledStart: start,
        scheduledEnd: end,
        status: released && b.status === 'ASSIGNED' ? 'CONFIRMED' : b.status,
        reminderSentAt: null, // remind for the NEW time
      },
    });
  });

  // The business (and customers' own history) must know: staff were never told.
  try {
    await require('../notifications/notifications.service').notifyBookingRescheduled(businessId, updated);
  } catch (e) {
    /* non-fatal */
  }
  return updated;
}

async function leaveReview(businessId, customerId, bookingId, { rating, comment }) {
  const b = await findMyBooking(businessId, customerId, bookingId);
  if (b.status !== 'COMPLETED') {
    const err = new Error('You can only review completed bookings');
    err.status = 422;
    throw err;
  }
  if (b.review) {
    const err = new Error('Review already submitted');
    err.status = 409;
    throw err;
  }
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) {
    const err = new Error('rating must be an integer 1-5');
    err.status = 422;
    throw err;
  }
  // Attribute the review to whichever cleaner actually did the job. A
  // booking can in principle carry more than one assignment (reassignment
  // history) — the most recently assigned cleaner is the one who completed
  // it, so that's who the rating reflects.
  const primaryAssignment = await prisma.bookingAssignment.findFirst({
    where: { bookingId },
    orderBy: { assignedAt: 'desc' },
  });

  return prisma.review.create({
    data: {
      businessId,
      bookingId,
      customerId,
      cleanerId: primaryAssignment?.cleanerId || null,
      rating: r,
      comment: comment || null,
    },
  });
}

/**
 * Referral programme view: the customer's code, how many friends used it and
 * the reward coupons they have earned.
 */
async function getReferral(businessId, customerId) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, businessId },
    select: { referralCode: true },
  });
  if (!customer) {
    const err = new Error('Customer not found');
    err.status = 404;
    throw err;
  }
  const code =
    customer.referralCode || (await require('../customers/customers.service').ensureReferralCode(customerId));

  const referred = await prisma.booking.findMany({
    where: { businessId, referredByCustomerId: customerId },
    select: { customerId: true, status: true },
  });
  const friendsBooked = new Set(referred.map((r) => r.customerId)).size;
  const friendsCompleted = new Set(referred.filter((r) => r.status === 'COMPLETED').map((r) => r.customerId)).size;

  const coupons = await prisma.coupon.findMany({
    where: { businessId, ownerCustomerId: customerId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const now = Date.now();
  const rewards = coupons.map((c) => {
    const used = c.maxRedemptions != null && (c.redeemedCount || 0) >= c.maxRedemptions;
    const expired = !!c.expiresAt && new Date(c.expiresAt).getTime() < now;
    return {
      code: c.code,
      valueCents: c.value,
      expiresAt: c.expiresAt,
      status: used ? 'USED' : expired || !c.isActive ? 'EXPIRED' : 'AVAILABLE',
    };
  });

  return {
    code,
    giveCents: REFERRAL_DISCOUNT_CENTS,
    getCents: REFERRAL_REWARD_CENTS,
    friendsBooked,
    friendsCompleted,
    earnedCents: friendsBooked * REFERRAL_REWARD_CENTS,
    rewards,
  };
}

/** Cleaners who have completed a job for this customer (the ones they can pick as preferred). */
async function listMyCleaners(businessId, customerId) {
  const [customer, rows] = await Promise.all([
    prisma.customer.findFirst({ where: { id: customerId, businessId }, select: { preferredCleanerId: true } }),
    prisma.bookingAssignment.findMany({
      where: { booking: { businessId, customerId, status: 'COMPLETED' } },
      include: { cleaner: { include: { user: { select: { firstName: true, lastName: true } } } } },
      orderBy: { assignedAt: 'desc' },
      take: 200,
    }),
  ]);
  const byId = new Map();
  for (const a of rows) {
    const c = a.cleaner;
    if (!c || c.status !== 'ACTIVE') continue;
    const entry = byId.get(c.id) || {
      id: c.id,
      name: `${c.user?.firstName || ''} ${c.user?.lastName || ''}`.trim(),
      jobs: 0,
    };
    entry.jobs += 1;
    byId.set(c.id, entry);
  }
  const cleaners = [...byId.values()].sort((a, b) => b.jobs - a.jobs);
  const preferredCleanerId = customer?.preferredCleanerId || null;
  return {
    preferredCleanerId: cleaners.some((c) => c.id === preferredCleanerId) ? preferredCleanerId : null,
    cleaners,
  };
}

/** Sets (or clears, with null) the customer's preferred cleaner. */
async function setPreferredCleaner(businessId, customerId, cleanerId) {
  if (cleanerId) {
    const { cleaners } = await listMyCleaners(businessId, customerId);
    if (!cleaners.some((c) => c.id === cleanerId)) {
      const err = new Error('You can only choose a cleaner who has cleaned for you before');
      err.status = 422;
      throw err;
    }
  }
  await prisma.customer.update({ where: { id: customerId }, data: { preferredCleanerId: cleanerId || null } });
  return listMyCleaners(businessId, customerId);
}

/** Everything the portal home screen needs in one call. */
async function getOverview(businessId, customerId, portalUserId) {
  const now = new Date();
  const open = { notIn: ['CANCELLED', 'COMPLETED'] };
  const [next, upcoming, completed, total, referral, mine, unreadMessages] = await Promise.all([
    prisma.booking.findFirst({
      where: { businessId, customerId, status: open, scheduledStart: { gte: now } },
      orderBy: { scheduledStart: 'asc' },
      include: {
        service: { select: { id: true, name: true } },
        assignments: { include: { cleaner: { include: { user: { select: { firstName: true, lastName: true } } } } } },
      },
    }),
    prisma.booking.count({ where: { businessId, customerId, status: open, scheduledStart: { gte: now } } }),
    prisma.booking.count({ where: { businessId, customerId, status: 'COMPLETED' } }),
    prisma.booking.count({ where: { businessId, customerId } }),
    getReferral(businessId, customerId),
    listMyCleaners(businessId, customerId),
    require('../bookingChat/bookingChat.service').unreadForCustomer(businessId, customerId, portalUserId),
  ]);
  const preferred = mine.cleaners.find((c) => c.id === mine.preferredCleanerId) || null;
  return {
    nextBooking: next,
    counts: { upcoming, completed, total },
    unreadMessages,
    preferredCleaner: preferred,
    referral: {
      code: referral.code,
      giveCents: referral.giveCents,
      getCents: referral.getCents,
      friendsBooked: referral.friendsBooked,
      availableRewards: referral.rewards.filter((r) => r.status === 'AVAILABLE').length,
    },
  };
}

module.exports = {
  getReferral,
  listMyCleaners,
  setPreferredCleaner,
  getOverview,
  getMyTimeline,
  requestAccess,
  verifyAccess,
  listMyBookings,
  getMyBooking,
  findMyBooking,
  MAX_TIP_CENTS,
  cancelMyBooking,
  rescheduleMyBooking,
  leaveReview,
  tipMyBooking,
};
