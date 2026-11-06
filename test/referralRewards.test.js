jest.mock('../src/config/database', () => ({
  booking: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  coupon: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  customer: { findFirst: jest.fn() },
  business: { findUnique: jest.fn() },
  businessPricing: { findUnique: jest.fn() },
}));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn().mockResolvedValue() }));
jest.mock('../src/lib/notificationClient', () => ({ sendSms: jest.fn().mockResolvedValue(), sendEmail: jest.fn().mockResolvedValue() }));

const prisma = require('../src/config/database');
const client = require('../src/lib/notificationClient');
const { issueRewardForBooking, issueDueRewards, completedAtOf } = require('../src/modules/referrals/referralRewards');
const svc = require('../src/modules/referrals/referrals.service');

const NOW = new Date('2026-11-10T12:00:00Z');
const done = new Date('2026-11-08T12:00:00Z');
const booking = (o = {}) => ({ id: 'bk', referredByCustomerId: 'r1', referralRewardCents: 2000, updatedAt: done, assignments: [{ checkedOutAt: done }], ...o });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.booking.findFirst.mockResolvedValue(booking());
  prisma.coupon.findFirst.mockResolvedValue(null);
  prisma.coupon.create.mockImplementation(async ({ data }) => ({ id: 'cp1', ...data }));
  prisma.customer.findFirst.mockResolvedValue({ id: 'r1', phone: '+31611111111', email: 'r@x.nl' });
  prisma.business.findUnique.mockResolvedValue({ name: 'Tod', currency: 'eur' });
  prisma.businessPricing.findUnique.mockResolvedValue(null);
});

describe('issueRewardForBooking', () => {
  test('issues the promised amount once the visit is completed, and tells the referrer', async () => {
    const r = await issueRewardForBooking('biz', 'bk', { now: NOW });
    expect(r).toMatchObject({ issued: true, couponId: 'cp1' });
    const data = prisma.coupon.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ businessId: 'biz', value: 2000, maxRedemptions: 1, ownerCustomerId: 'r1', sourceBookingId: 'bk' });
    expect(data.code).toMatch(/^REF-[0-9A-F]{8}$/);
    expect(data.expiresAt.getTime()).toBe(NOW.getTime() + 90 * 864e5);
    expect(client.sendSms).toHaveBeenCalled();
    expect(client.sendEmail).toHaveBeenCalled();
    // eligibility is queried on completed + referred bookings of this business only
    expect(prisma.booking.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'bk', businessId: 'biz', status: 'COMPLETED', referredByCustomerId: { not: null } });
  });

  test('uses the amount promised at booking time, not the current setting', async () => {
    prisma.businessPricing.findUnique.mockResolvedValue({ referralRewardCents: 9999 });
    await issueRewardForBooking('biz', 'bk', { now: NOW });
    expect(prisma.coupon.create.mock.calls[0][0].data.value).toBe(2000);
  });

  test('is idempotent', async () => {
    prisma.coupon.findFirst.mockResolvedValue({ id: 'old', code: 'REF-OLD' });
    expect(await issueRewardForBooking('biz', 'bk', { now: NOW })).toMatchObject({ issued: false, reason: 'ALREADY_ISSUED', couponId: 'old' });
    expect(prisma.coupon.create).not.toHaveBeenCalled();
  });

  test('a lost race on the unique sourceBookingId is not an error', async () => {
    prisma.coupon.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002', meta: { target: ['sourceBookingId'] } }));
    expect(await issueRewardForBooking('biz', 'bk', { now: NOW })).toMatchObject({ issued: false, reason: 'ALREADY_ISSUED' });
  });

  test('a code collision retries with a new code', async () => {
    prisma.coupon.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002', meta: { target: ['businessId', 'code'] } }));
    expect((await issueRewardForBooking('biz', 'bk', { now: NOW })).issued).toBe(true);
    expect(prisma.coupon.create).toHaveBeenCalledTimes(2);
  });

  test('nothing for a non-referral, not-completed, or forfeited booking', async () => {
    prisma.booking.findFirst.mockResolvedValueOnce(null);
    expect(await issueRewardForBooking('biz', 'bk', { now: NOW })).toMatchObject({ issued: false, reason: 'NOT_ELIGIBLE' });
    prisma.booking.findFirst.mockResolvedValueOnce(booking({ referralRewardCents: 0 }));
    expect(await issueRewardForBooking('biz', 'bk', { now: NOW })).toMatchObject({ issued: false, reason: 'NO_REWARD' });
    expect(prisma.coupon.create).not.toHaveBeenCalled();
  });

  test('the hold period delays the reward until it has passed', async () => {
    prisma.businessPricing.findUnique.mockResolvedValue({ referralHoldDays: 7 });
    const early = await issueRewardForBooking('biz', 'bk', { now: NOW });
    expect(early).toMatchObject({ issued: false, reason: 'HOLD' });
    expect(early.availableAt.getTime()).toBe(done.getTime() + 7 * 864e5);
    expect(prisma.coupon.create).not.toHaveBeenCalled();
    const later = await issueRewardForBooking('biz', 'bk', { now: new Date(done.getTime() + 7 * 864e5 + 1000) });
    expect(later.issued).toBe(true);
  });

  test('a notification failure never loses the reward', async () => {
    client.sendSms.mockRejectedValueOnce(new Error('sms down'));
    expect((await issueRewardForBooking('biz', 'bk', { now: NOW })).issued).toBe(true);
  });
});

test('completedAtOf prefers check-out time, falls back to updatedAt', () => {
  expect(completedAtOf(booking()).getTime()).toBe(done.getTime());
  expect(completedAtOf(booking({ assignments: [] })).getTime()).toBe(done.getTime());
});

describe('issueDueRewards (daemon sweep)', () => {
  test('issues only for completed referrals that have no coupon yet', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: 'a', businessId: 'biz' }, { id: 'b', businessId: 'biz' }]);
    prisma.coupon.findMany.mockResolvedValue([{ sourceBookingId: 'a' }]);
    prisma.booking.findFirst.mockResolvedValue(booking({ id: 'b' }));
    const r = await issueDueRewards({ now: NOW });
    expect(r).toEqual({ scanned: 2, issued: 1, errors: 0 });
    expect(prisma.coupon.create.mock.calls[0][0].data.sourceBookingId).toBe('b');
  });
  test('one failing booking does not stop the rest', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: 'a', businessId: 'biz' }, { id: 'b', businessId: 'biz' }]);
    prisma.coupon.findMany.mockResolvedValue([]);
    prisma.booking.findFirst.mockRejectedValueOnce(new Error('db')).mockResolvedValueOnce(booking({ id: 'b' }));
    expect(await issueDueRewards({ now: NOW })).toEqual({ scanned: 2, issued: 1, errors: 1 });
  });
});

describe('admin: pending rewards', () => {
  test('pendingReward states', () => {
    expect(svc.pendingReward({ status: 'CONFIRMED', referralRewardCents: 2000 })).toMatchObject({ status: 'PENDING', waitingFor: 'VISIT', valueCents: 2000 });
    expect(svc.pendingReward({ status: 'COMPLETED', referralRewardCents: 2000 })).toMatchObject({ waitingFor: 'HOLD' });
    expect(svc.pendingReward({ status: 'CANCELLED', referralRewardCents: 2000 })).toBeNull();
    expect(svc.pendingReward({ status: 'CONFIRMED', referralRewardCents: 0 })).toBeNull();
  });

  test('summarise counts promised-but-not-issued rewards', () => {
    const s = svc.summarise(
      [
        { id: 'a', status: 'CONFIRMED', referredByCustomerId: 'r', referralDiscountCents: 2000, referralRewardCents: 2000 },
        { id: 'b', status: 'COMPLETED', referredByCustomerId: 'r', referralDiscountCents: 2000, referralRewardCents: 2000 },
      ],
      [{ sourceBookingId: 'b', value: 2000, maxRedemptions: 1, redeemedCount: 0, isActive: true }]
    );
    expect(s).toMatchObject({ rewardsPendingCents: 2000, rewardsIssuedCents: 2000 });
  });

  test('forfeit withdraws a pending reward but not an issued one', async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: 'bk', referralRewardCents: 2000 });
    expect(await svc.forfeitPendingReward('biz', 'bk', 'u1')).toEqual({ bookingId: 'bk', status: 'FORFEITED' });
    expect(prisma.booking.update).toHaveBeenCalledWith({ where: { id: 'bk' }, data: { referralRewardCents: 0 } });
    prisma.coupon.findFirst.mockResolvedValue({ id: 'cp' });
    await expect(svc.forfeitPendingReward('biz', 'bk')).rejects.toMatchObject({ status: 409 });
    prisma.booking.findFirst.mockResolvedValue(null);
    await expect(svc.forfeitPendingReward('biz', 'nope')).rejects.toMatchObject({ status: 404 });
  });
});
