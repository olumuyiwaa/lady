jest.mock('../src/config/database', () => ({
  businessPricing: { findUnique: jest.fn(), upsert: jest.fn() },
  booking: { count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  customer: { findMany: jest.fn() },
  coupon: { findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
}));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn().mockResolvedValue() }));

const prisma = require('../src/config/database');
const { audit } = require('../src/utils/audit');
const lib = require('../src/lib/referral');
const svc = require('../src/modules/referrals/referrals.service');

beforeEach(() => jest.clearAllMocks());

test('modules load and every export is defined', () => {
  for (const m of [lib, svc, require('../src/modules/referrals/referrals.controller')]) {
    for (const [k, v] of Object.entries(m)) expect([k, v === undefined]).toEqual([k, false]);
  }
});

describe('settings', () => {
  test('defaults when no row, and when the lookup fails', async () => {
    prisma.businessPricing.findUnique.mockResolvedValueOnce(null);
    expect(await lib.getReferralSettings('b')).toEqual({ enabled: true, discountCents: 2000, rewardCents: 2000, rewardValidDays: 90, minBookingCents: 0, holdDays: 0 });
    prisma.businessPricing.findUnique.mockRejectedValueOnce(new Error('column missing'));
    expect((await lib.getReferralSettings('b')).enabled).toBe(true);
  });

  test('update validates, upserts only provided keys and audits', async () => {
    prisma.businessPricing.findUnique.mockResolvedValue({ referralEnabled: false, referralDiscountCents: 1500 });
    const r = await svc.updateSettings('b', { enabled: false, discountCents: 1500 }, 'u1');
    expect(prisma.businessPricing.upsert).toHaveBeenCalledWith({
      where: { businessId: 'b' },
      create: { businessId: 'b', referralEnabled: false, referralDiscountCents: 1500 },
      update: { referralEnabled: false, referralDiscountCents: 1500 },
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'REFERRAL_SETTINGS_UPDATED', actorUserId: 'u1' }));
    expect(r).toMatchObject({ enabled: false, discountCents: 1500 });
    await expect(svc.updateSettings('b', { discountCents: -5 })).rejects.toMatchObject({ status: 422 });
    await expect(svc.updateSettings('b', { rewardValidDays: 0 })).rejects.toMatchObject({ status: 422 });
    await expect(svc.updateSettings('b', { rewardCents: 1.5 })).rejects.toMatchObject({ status: 422 });
  });
});

describe('detectSelfReferral', () => {
  const ref = { phone: '+31 6 12345678', email: 'anna.b@gmail.com' };
  test.each([
    [{ phone: '0612345678', email: 'x@y.nl' }, 'SAME_PHONE'],
    [{ phone: '0699999999', email: 'AnnaB+promo@googlemail.com' }, 'SAME_EMAIL'],
    [{ phone: '0699999999', email: 'x@y.nl', addressLine1: 'Dam  1', postalCode: '1012 js' }, 'SAME_ADDRESS'],
    [{ phone: '0699999999', email: 'x@y.nl', addressLine1: 'Dam 2', postalCode: '1012JS' }, null],
  ])('%j -> %s', (newcomer, expected) => {
    expect(lib.detectSelfReferral(ref, [{ line1: 'Dam 1', postalCode: '1012JS' }], newcomer)).toBe(expected);
  });
  test('empty values never match each other', () => {
    expect(lib.detectSelfReferral({ phone: null, email: null }, [], { phone: '', email: '' })).toBeNull();
  });
});

describe('summarise', () => {
  const future = new Date(Date.now() + 864e5);
  test('totals, reward states and top referrers', () => {
    const s = svc.summarise(
      [
        { status: 'COMPLETED', referredByCustomerId: 'r1', referralDiscountCents: 2000 },
        { status: 'CONFIRMED', referredByCustomerId: 'r1', referralDiscountCents: 2000 },
        { status: 'CANCELLED', referredByCustomerId: 'r2', referralDiscountCents: 2000 },
      ],
      [
        { value: 2000, maxRedemptions: 1, redeemedCount: 1, isActive: true, expiresAt: future },
        { value: 2000, maxRedemptions: 1, redeemedCount: 0, isActive: true, expiresAt: future },
        { value: 2000, maxRedemptions: 1, redeemedCount: 0, isActive: false, expiresAt: future },
      ]
    );
    expect(s).toMatchObject({ referrals: 2, completed: 1, discountGivenCents: 4000, rewardsIssuedCents: 4000, rewardsUsedCents: 2000, rewardsOutstandingCents: 2000 });
    expect(s.topReferrers).toEqual([{ customerId: 'r1', count: 2 }]);
  });
});

describe('listReferrals', () => {
  test('joins referrer, reward and flags high volume', async () => {
    prisma.booking.count.mockResolvedValue(1);
    prisma.booking.findMany.mockResolvedValue([
      { id: 'bk1', createdAt: new Date(), status: 'CONFIRMED', customerId: 'n1', referredByCustomerId: 'r1', referralDiscountCents: 2000, customer: { id: 'n1', firstName: 'Nina', lastName: 'K' } },
    ]);
    prisma.customer.findMany.mockResolvedValue([{ id: 'r1', firstName: 'Rob', lastName: 'V', referralCode: 'ABC234' }]);
    prisma.coupon.findMany.mockResolvedValue([{ id: 'cp1', sourceBookingId: 'bk1', code: 'REF-1', value: 2000, maxRedemptions: 1, redeemedCount: 0, isActive: true, expiresAt: new Date(Date.now() + 864e5) }]);
    prisma.booking.groupBy.mockResolvedValue([{ referredByCustomerId: 'r1', _count: { _all: 6 } }]);
    const r = await svc.listReferrals('biz', {});
    expect(r.data[0]).toMatchObject({
      referredCustomer: { name: 'Nina K' }, referrer: { name: 'Rob V', code: 'ABC234' }, discountCents: 2000,
      reward: { code: 'REF-1', status: 'AVAILABLE' }, flags: ['HIGH_VOLUME'],
    });
    expect(prisma.booking.findMany.mock.calls[0][0].where).toMatchObject({ businessId: 'biz' });
    const flagged = await svc.listReferrals('biz', { flagged: 'true' });
    expect(flagged.data).toHaveLength(1);
  });
});

describe('cancelReward', () => {
  test('cancels an unused reward and audits', async () => {
    prisma.coupon.findFirst.mockResolvedValue({ id: 'cp', code: 'REF-1', maxRedemptions: 1, redeemedCount: 0, isActive: true, sourceBookingId: 'bk' });
    expect(await svc.cancelReward('biz', 'cp', 'u1')).toEqual({ id: 'cp', status: 'CANCELLED' });
    expect(prisma.coupon.update).toHaveBeenCalledWith({ where: { id: 'cp' }, data: { isActive: false } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'REFERRAL_REWARD_CANCELLED' }));
  });
  test('404 when not a referral reward of this business, 409 when used', async () => {
    prisma.coupon.findFirst.mockResolvedValue(null);
    await expect(svc.cancelReward('biz', 'x')).rejects.toMatchObject({ status: 404 });
    expect(prisma.coupon.findFirst.mock.calls[0][0].where).toMatchObject({ businessId: 'biz', sourceBookingId: { not: null } });
    prisma.coupon.findFirst.mockResolvedValue({ id: 'cp', maxRedemptions: 1, redeemedCount: 1, isActive: true });
    await expect(svc.cancelReward('biz', 'cp')).rejects.toMatchObject({ status: 409 });
    expect(prisma.coupon.update).not.toHaveBeenCalled();
  });
});
