jest.mock('../src/config/database.js', () => ({
  customer: { findFirst: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  booking: { findMany: jest.fn() },
  coupon: { findMany: jest.fn() },
  bookingAssignment: { findMany: jest.fn() },
}));
jest.mock('../src/lib/notificationClient', () => ({ sendSms: jest.fn(), sendEmail: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({ createRefund: jest.fn(), createAncillaryCheckoutSession: jest.fn() }));

const prisma = require('../src/config/database.js');
const service = require('../src/modules/customerPortal/customerPortal.service');

const cleanerRow = (id, first, status = 'ACTIVE') => ({ cleaner: { id, status, user: { firstName: first, lastName: 'X' } } });

beforeEach(() => jest.resetAllMocks());

describe('getReferral', () => {
  test('reports the €20/€20 offer, friends who booked and reward coupons', async () => {
    prisma.customer.findFirst.mockResolvedValue({ referralCode: 'ABC234' });
    prisma.booking.findMany.mockResolvedValue([
      { customerId: 'f1', status: 'COMPLETED' },
      { customerId: 'f1', status: 'COMPLETED' },
      { customerId: 'f2', status: 'CONFIRMED' },
    ]);
    const future = new Date(Date.now() + 86400e3);
    const past = new Date(Date.now() - 86400e3);
    prisma.coupon.findMany.mockResolvedValue([
      { code: 'REF-1', value: 2000, maxRedemptions: 1, redeemedCount: 0, expiresAt: future, isActive: true },
      { code: 'REF-2', value: 2000, maxRedemptions: 1, redeemedCount: 1, expiresAt: future, isActive: true },
      { code: 'REF-3', value: 2000, maxRedemptions: 1, redeemedCount: 0, expiresAt: past, isActive: true },
    ]);
    const r = await service.getReferral('biz1', 'cust1');
    expect(r).toMatchObject({ code: 'ABC234', giveCents: 2000, getCents: 2000, friendsBooked: 2, friendsCompleted: 1, earnedCents: 4000 });
    expect(r.rewards.map((x) => x.status)).toEqual(['AVAILABLE', 'USED', 'EXPIRED']);
    expect(prisma.booking.findMany.mock.calls[0][0].where).toEqual({ businessId: 'biz1', referredByCustomerId: 'cust1' });
    expect(prisma.coupon.findMany.mock.calls[0][0].where).toEqual({ businessId: 'biz1', ownerCustomerId: 'cust1' });
  });
  test('404 for an unknown customer', async () => {
    prisma.customer.findFirst.mockResolvedValue(null);
    await expect(service.getReferral('biz1', 'nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('preferred cleaner', () => {
  test('lists only active cleaners who completed a job, most jobs first', async () => {
    prisma.customer.findFirst.mockResolvedValue({ preferredCleanerId: 'c2' });
    prisma.bookingAssignment.findMany.mockResolvedValue([
      cleanerRow('c1', 'Piet'), cleanerRow('c2', 'Sara'), cleanerRow('c2', 'Sara'), cleanerRow('c3', 'Gone', 'SUSPENDED'),
    ]);
    const r = await service.listMyCleaners('biz1', 'cust1');
    expect(r.cleaners.map((c) => [c.id, c.jobs])).toEqual([['c2', 2], ['c1', 1]]);
    expect(r.preferredCleanerId).toBe('c2');
    expect(prisma.bookingAssignment.findMany.mock.calls[0][0].where).toEqual({ booking: { businessId: 'biz1', customerId: 'cust1', status: 'COMPLETED' } });
  });
  test('a preference for a cleaner who is no longer available is not reported', async () => {
    prisma.customer.findFirst.mockResolvedValue({ preferredCleanerId: 'c3' });
    prisma.bookingAssignment.findMany.mockResolvedValue([cleanerRow('c1', 'Piet')]);
    expect((await service.listMyCleaners('biz1', 'cust1')).preferredCleanerId).toBeNull();
  });
  test('cannot pick a cleaner who has never cleaned for the customer', async () => {
    prisma.customer.findFirst.mockResolvedValue({ preferredCleanerId: null });
    prisma.bookingAssignment.findMany.mockResolvedValue([cleanerRow('c1', 'Piet')]);
    await expect(service.setPreferredCleaner('biz1', 'cust1', 'stranger')).rejects.toMatchObject({ status: 422 });
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });
  test('saves a valid choice and clears with null', async () => {
    prisma.customer.findFirst.mockResolvedValue({ preferredCleanerId: null });
    prisma.bookingAssignment.findMany.mockResolvedValue([cleanerRow('c1', 'Piet')]);
    await service.setPreferredCleaner('biz1', 'cust1', 'c1');
    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: 'cust1' }, data: { preferredCleanerId: 'c1' } });
    await service.setPreferredCleaner('biz1', 'cust1', null);
    expect(prisma.customer.update).toHaveBeenLastCalledWith({ where: { id: 'cust1' }, data: { preferredCleanerId: null } });
  });
});
