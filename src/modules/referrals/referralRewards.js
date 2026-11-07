/**
 * Issues the referrer's reward once the referred customer's first visit is
 * completed.
 *
 * The amount is the one promised when the booking was made
 * (Booking.referralRewardCents); the coupon's validity and the optional hold
 * period come from the business's current referral settings. Issuing is
 * idempotent: Coupon.sourceBookingId is unique, so completing twice, a retry
 * from the daemon, or two racing requests can only ever create one coupon.
 */
const crypto = require('crypto');
const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { audit } = require('../../utils/audit');
const { getReferralSettings } = require('../../lib/referral');

const DAY = 24 * 60 * 60 * 1000;
const SWEEP_LOOKBACK_DAYS = 120;

function money(cents, currency) {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: String(currency || 'eur').toUpperCase() }).format((cents || 0) / 100);
}

/** Pure: when the visit counts as finished. */
function completedAtOf(booking) {
  const outs = (booking.assignments || []).map((a) => a.checkedOutAt).filter(Boolean).map((d) => new Date(d).getTime());
  return new Date(outs.length ? Math.max(...outs) : new Date(booking.updatedAt).getTime());
}

/**
 * @returns {Promise<{issued:boolean, reason?:string, couponId?:string, code?:string, availableAt?:Date}>}
 */
async function issueRewardForBooking(businessId, bookingId, { now = new Date() } = {}) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId, status: 'COMPLETED', referredByCustomerId: { not: null } },
    select: {
      id: true, referredByCustomerId: true, referralRewardCents: true, updatedAt: true,
      assignments: { select: { checkedOutAt: true } },
    },
  });
  if (!booking) return { issued: false, reason: 'NOT_ELIGIBLE' };
  if (!(booking.referralRewardCents > 0)) return { issued: false, reason: 'NO_REWARD' };

  const existing = await prisma.coupon.findFirst({ where: { businessId, sourceBookingId: bookingId }, select: { id: true, code: true } });
  if (existing) return { issued: false, reason: 'ALREADY_ISSUED', couponId: existing.id, code: existing.code };

  const settings = await getReferralSettings(businessId);
  const availableAt = new Date(completedAtOf(booking).getTime() + settings.holdDays * DAY);
  if (now < availableAt) return { issued: false, reason: 'HOLD', availableAt };

  const referrer = await prisma.customer.findFirst({ where: { id: booking.referredByCustomerId, businessId } });
  if (!referrer) return { issued: false, reason: 'NO_REFERRER' };

  let coupon = null;
  for (let attempt = 0; attempt < 3 && !coupon; attempt++) {
    try {
      coupon = await prisma.coupon.create({
        data: {
          businessId,
          code: `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
          type: 'AMOUNT',
          value: booking.referralRewardCents,
          maxRedemptions: 1,
          ownerCustomerId: referrer.id,
          sourceBookingId: bookingId,
          expiresAt: new Date(now.getTime() + settings.rewardValidDays * DAY),
        },
      });
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      const target = String((e.meta && e.meta.target) || '');
      if (target.includes('sourceBookingId')) return { issued: false, reason: 'ALREADY_ISSUED' }; // lost a race: someone else issued it
      // otherwise a code collision: loop and try a new code
    }
  }
  if (!coupon) return { issued: false, reason: 'CODE_COLLISION' };

  try {
    await audit({ businessId, action: 'REFERRAL_REWARD_ISSUED', entityType: 'Coupon', entityId: coupon.id, metadata: { bookingId, referrerId: referrer.id, valueCents: coupon.value } });
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { name: true, currency: true } });
    const { notifyCustomer } = require('../../lib/customerNotify');
    await notifyCustomer(referrer, 'referralReward', { business: business?.name || '', code: coupon.code, amount: money(coupon.value, business?.currency) }, { html: true });
  } catch (e) {
    logger.warn('referral reward notification failed', { bookingId, error: e.message });
  }
  return { issued: true, couponId: coupon.id, code: coupon.code };
}

/**
 * Daemon sweep: issues rewards whose hold has ended, and retries any whose
 * completion-time attempt failed. Bounded and safe to run every few minutes.
 */
async function issueDueRewards({ now = new Date() } = {}) {
  const candidates = await prisma.booking.findMany({
    where: {
      status: 'COMPLETED',
      referredByCustomerId: { not: null },
      referralRewardCents: { gt: 0 },
      updatedAt: { gte: new Date(now.getTime() - SWEEP_LOOKBACK_DAYS * DAY) },
    },
    select: { id: true, businessId: true },
    orderBy: { updatedAt: 'desc' },
    take: 300,
  });
  if (candidates.length === 0) return { scanned: 0, issued: 0 };

  const have = await prisma.coupon.findMany({ where: { sourceBookingId: { in: candidates.map((c) => c.id) } }, select: { sourceBookingId: true } });
  const done = new Set(have.map((c) => c.sourceBookingId));
  const stats = { scanned: candidates.length, issued: 0, errors: 0 };
  for (const c of candidates.filter((x) => !done.has(x.id))) {
    try {
      const r = await issueRewardForBooking(c.businessId, c.id, { now });
      if (r.issued) stats.issued += 1;
    } catch (e) {
      stats.errors += 1;
      logger.error('referral reward sweep failed', { bookingId: c.id, error: e.message });
    }
  }
  if (stats.issued || stats.errors) logger.info('referral reward sweep finished', stats);
  return stats;
}

module.exports = { issueRewardForBooking, issueDueRewards, completedAtOf };
