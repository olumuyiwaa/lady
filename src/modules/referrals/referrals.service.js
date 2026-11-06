/**
 * Admin side of the referral programme: settings, the list of referrals with
 * their rewards, headline numbers, and cancelling a reward.
 *
 * A "referral" is a booking placed with a friend's code (Booking.referredByCustomerId).
 * Its reward is the coupon whose sourceBookingId is that booking.
 */
const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const { getReferralSettings } = require('../../lib/referral');

const HIGH_VOLUME_THRESHOLD = 5; // referrals by one customer within 30 days
const DAY = 24 * 60 * 60 * 1000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const fullName = (c) => (c ? [c.firstName, c.lastName].filter(Boolean).join(' ') : null);

function rewardStatus(c, now = Date.now()) {
  if (!c) return null;
  if (c.maxRedemptions != null && (c.redeemedCount || 0) >= c.maxRedemptions) return 'USED';
  if (!c.isActive) return 'CANCELLED';
  if (c.expiresAt && new Date(c.expiresAt).getTime() < now) return 'EXPIRED';
  return 'AVAILABLE';
}

/** Pure: headline numbers from referral bookings and reward coupons. */
function summarise(bookings, coupons, now = Date.now()) {
  const live = bookings.filter((b) => b.status !== 'CANCELLED');
  const sum = (xs, f) => xs.reduce((a, x) => a + (f(x) || 0), 0);
  const byStatus = (st) => coupons.filter((c) => rewardStatus(c, now) === st);
  const perReferrer = new Map();
  for (const b of live) perReferrer.set(b.referredByCustomerId, (perReferrer.get(b.referredByCustomerId) || 0) + 1);
  const rewarded = new Set(coupons.map((c) => c.sourceBookingId).filter(Boolean));
  return {
    referrals: live.length,
    // Promised to referrers but not yet earned (visit not done, or in the hold period).
    rewardsPendingCents: sum(live.filter((b) => b.id && !rewarded.has(b.id)), (b) => b.referralRewardCents),
    completed: live.filter((b) => b.status === 'COMPLETED').length,
    discountGivenCents: sum(live, (b) => b.referralDiscountCents),
    rewardsIssuedCents: sum(coupons.filter((c) => rewardStatus(c, now) !== 'CANCELLED'), (c) => c.value),
    rewardsUsedCents: sum(byStatus('USED'), (c) => c.value),
    rewardsOutstandingCents: sum(byStatus('AVAILABLE'), (c) => c.value),
    topReferrers: [...perReferrer.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([customerId, count]) => ({ customerId, count })),
  };
}

/** Reward promised on a referral that has no coupon yet (null when nothing is owed). */
function pendingReward(b) {
  if (b.status === 'CANCELLED' || !(b.referralRewardCents > 0)) return null;
  return {
    couponId: null,
    code: null,
    valueCents: b.referralRewardCents,
    status: 'PENDING',
    waitingFor: b.status === 'COMPLETED' ? 'HOLD' : 'VISIT',
    expiresAt: null,
  };
}

async function getSettings(businessId) {
  return getReferralSettings(businessId);
}

function intIn(v, name, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw httpError(422, `${name} must be a whole number between ${min} and ${max}`);
  return n;
}

async function updateSettings(businessId, body = {}, actorUserId = null) {
  const data = {};
  if (body.enabled !== undefined) data.referralEnabled = !!body.enabled;
  if (body.discountCents !== undefined) data.referralDiscountCents = intIn(body.discountCents, 'discountCents', 0, 50000);
  if (body.rewardCents !== undefined) data.referralRewardCents = intIn(body.rewardCents, 'rewardCents', 0, 50000);
  if (body.rewardValidDays !== undefined) data.referralRewardValidDays = intIn(body.rewardValidDays, 'rewardValidDays', 1, 730);
  if (body.holdDays !== undefined) data.referralHoldDays = intIn(body.holdDays, 'holdDays', 0, 60);
  if (body.minBookingCents !== undefined) data.referralMinBookingCents = intIn(body.minBookingCents, 'minBookingCents', 0, 1000000);
  await prisma.businessPricing.upsert({ where: { businessId }, create: { businessId, ...data }, update: data });
  await audit({ businessId, actorUserId, action: 'REFERRAL_SETTINGS_UPDATED', entityType: 'BusinessPricing', entityId: businessId, metadata: data });
  return getReferralSettings(businessId);
}

async function listReferrals(businessId, { page = 1, limit = 25, flagged } = {}) {
  const take = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
  const skip = (Math.max(1, parseInt(page, 10) || 1) - 1) * take;
  const where = { businessId, referredByCustomerId: { not: null } };

  const [total, bookings] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true, createdAt: true, status: true, customerId: true, referredByCustomerId: true, referralDiscountCents: true, referralRewardCents: true,
        customer: { select: { id: true, firstName: true, lastName: true } },
      },
    }),
  ]);

  const referrerIds = [...new Set(bookings.map((b) => b.referredByCustomerId))];
  const [referrers, coupons, recent] = await Promise.all([
    referrerIds.length ? prisma.customer.findMany({ where: { businessId, id: { in: referrerIds } }, select: { id: true, firstName: true, lastName: true, referralCode: true } }) : [],
    bookings.length ? prisma.coupon.findMany({ where: { businessId, sourceBookingId: { in: bookings.map((b) => b.id) } } }) : [],
    referrerIds.length
      ? prisma.booking.groupBy({
          by: ['referredByCustomerId'],
          where: { businessId, referredByCustomerId: { in: referrerIds }, createdAt: { gte: new Date(Date.now() - 30 * DAY) } },
          _count: { _all: true },
        })
      : [],
  ]);
  const refMap = Object.fromEntries(referrers.map((r) => [r.id, r]));
  const couponMap = Object.fromEntries(coupons.map((c) => [c.sourceBookingId, c]));
  const volume = Object.fromEntries(recent.map((r) => [r.referredByCustomerId, r._count._all]));

  let rows = bookings.map((b) => {
    const c = couponMap[b.id];
    const ref = refMap[b.referredByCustomerId];
    return {
      bookingId: b.id,
      createdAt: b.createdAt,
      bookingStatus: b.status,
      referredCustomer: { id: b.customerId, name: fullName(b.customer) },
      referrer: { id: b.referredByCustomerId, name: fullName(ref), code: ref?.referralCode || null },
      discountCents: b.referralDiscountCents || 0,
      reward: c
        ? { couponId: c.id, code: c.code, valueCents: c.value, status: rewardStatus(c), expiresAt: c.expiresAt }
        : pendingReward(b),
      flags: (volume[b.referredByCustomerId] || 0) >= HIGH_VOLUME_THRESHOLD ? ['HIGH_VOLUME'] : [],
    };
  });
  if (flagged === 'true' || flagged === true) rows = rows.filter((r) => r.flags.length > 0);
  return { data: rows, pagination: { page: Math.floor(skip / take) + 1, limit: take, total } };
}

async function getStats(businessId) {
  const [bookings, coupons] = await Promise.all([
    prisma.booking.findMany({
      where: { businessId, referredByCustomerId: { not: null } },
      select: { id: true, status: true, referredByCustomerId: true, referralDiscountCents: true, referralRewardCents: true },
      take: 10000,
    }),
    prisma.coupon.findMany({ where: { businessId, sourceBookingId: { not: null } }, take: 10000 }),
  ]);
  const s = summarise(bookings, coupons);
  const ids = s.topReferrers.map((t) => t.customerId);
  const names = ids.length ? await prisma.customer.findMany({ where: { businessId, id: { in: ids } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const nameMap = Object.fromEntries(names.map((n) => [n.id, fullName(n)]));
  return { ...s, topReferrers: s.topReferrers.map((t) => ({ ...t, name: nameMap[t.customerId] || null })) };
}

/** Deactivates an unused referral reward (e.g. confirmed abuse). */
async function cancelReward(businessId, couponId, actorUserId = null) {
  const coupon = await prisma.coupon.findFirst({ where: { id: couponId, businessId, sourceBookingId: { not: null } } });
  if (!coupon) throw httpError(404, 'Reward not found');
  const status = rewardStatus(coupon);
  if (status === 'USED') throw httpError(409, 'This reward has already been used');
  if (status === 'CANCELLED') return { id: coupon.id, status };
  await prisma.coupon.update({ where: { id: coupon.id }, data: { isActive: false } });
  await audit({ businessId, actorUserId, action: 'REFERRAL_REWARD_CANCELLED', entityType: 'Coupon', entityId: coupon.id, metadata: { code: coupon.code, sourceBookingId: coupon.sourceBookingId } });
  return { id: coupon.id, status: 'CANCELLED' };
}

/** Withdraws a reward that has been promised but not issued yet (e.g. suspected abuse). */
async function forfeitPendingReward(businessId, bookingId, actorUserId = null) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId, referredByCustomerId: { not: null } },
    select: { id: true, referralRewardCents: true },
  });
  if (!booking) throw httpError(404, 'Referral not found');
  const issued = await prisma.coupon.findFirst({ where: { businessId, sourceBookingId: bookingId }, select: { id: true } });
  if (issued) throw httpError(409, 'The reward has already been issued; cancel the coupon instead');
  if (!(booking.referralRewardCents > 0)) return { bookingId, status: 'NONE' };
  await prisma.booking.update({ where: { id: bookingId }, data: { referralRewardCents: 0 } });
  await audit({ businessId, actorUserId, action: 'REFERRAL_REWARD_FORFEITED', entityType: 'Booking', entityId: bookingId, metadata: { valueCents: booking.referralRewardCents } });
  return { bookingId, status: 'FORFEITED' };
}

module.exports = {
  forfeitPendingReward,
  pendingReward, getSettings, updateSettings, listReferrals, getStats, cancelReward, summarise, rewardStatus, HIGH_VOLUME_THRESHOLD };
