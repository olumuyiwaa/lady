jest.mock('../src/config/database.js', () => {
  const db = {
    cleanerProfile: { findFirst: jest.fn(), update: jest.fn(), count: jest.fn() },
    bookingAssignment: { findMany: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
    booking: { update: jest.fn() },
    cleanerDeviceToken: { deleteMany: jest.fn() },
    session: { deleteMany: jest.fn() },
    businessSubscription: { findUnique: jest.fn() },
    user: { findUnique: jest.fn(), create: jest.fn() },
  };
  db.$transaction = jest.fn((fn) => fn(db));
  return db;
});
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/config/socket', () => ({ getIo: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({ sendInvite: jest.fn(), notifyMembers: jest.fn() }));

const prisma = require('../src/config/database.js');
const { getIo } = require('../src/config/socket');
const notifications = require('../src/modules/notifications/notifications.service');
const service = require('../src/modules/cleaners/cleaners.service');

const profile = { id: 'cl1', userId: 'u1', businessId: 'biz1', status: 'ACTIVE' };

describe('cleaner lifecycle', () => {
  let disconnect;
  beforeEach(() => {
    jest.clearAllMocks();
    disconnect = jest.fn();
    getIo.mockReturnValue({ in: jest.fn(() => ({ disconnectSockets: disconnect })) });
    prisma.cleanerProfile.findFirst.mockResolvedValue(profile);
    prisma.cleanerProfile.update.mockImplementation(({ data }) => ({ ...profile, ...data }));
  });

  test('offboarding unassigns future jobs, and a booking left with nobody returns to CONFIRMED', async () => {
    prisma.bookingAssignment.findMany.mockResolvedValue([
      { id: 'a1', bookingId: 'b1', booking: { id: 'b1', status: 'ASSIGNED' } },
      { id: 'a2', bookingId: 'b2', booking: { id: 'b2', status: 'ASSIGNED' } },
    ]);
    prisma.bookingAssignment.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1); // b2 still has a teammate

    const result = await service.offboardCleaner('biz1', 'owner1', 'cl1', 'left the company');

    expect(prisma.bookingAssignment.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['a1', 'a2'] } } });
    expect(prisma.booking.update).toHaveBeenCalledTimes(1);
    expect(prisma.booking.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { status: 'CONFIRMED' } });
    expect(result.status).toBe('OFFBOARDED');
    expect(result.unassignedBookingIds).toEqual(['b1', 'b2']);
  });

  test('offboarding removes push tokens and sessions for this business and drops live sockets', async () => {
    prisma.bookingAssignment.findMany.mockResolvedValue([]);
    await service.offboardCleaner('biz1', 'owner1', 'cl1', 'x');
    expect(prisma.cleanerDeviceToken.deleteMany).toHaveBeenCalledWith({ where: { cleanerId: 'cl1' } });
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', businessId: 'biz1' } });
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  test('managers are told which jobs need a new cleaner', async () => {
    prisma.bookingAssignment.findMany.mockResolvedValue([{ id: 'a1', bookingId: 'b1', booking: { id: 'b1', status: 'CONFIRMED' } }]);
    prisma.bookingAssignment.count.mockResolvedValue(0);
    await service.offboardCleaner('biz1', 'owner1', 'cl1', 'x');
    expect(notifications.notifyMembers).toHaveBeenCalledWith('biz1', 'JOBS_NEED_REASSIGNMENT', expect.any(String), expect.stringContaining('1 upcoming'));
  });

  test('jobs already started are left alone (only checkedInAt: null assignments are released)', async () => {
    prisma.bookingAssignment.findMany.mockResolvedValue([]);
    await service.offboardCleaner('biz1', 'owner1', 'cl1', 'x');
    expect(prisma.bookingAssignment.findMany.mock.calls[0][0].where).toMatchObject({ cleanerId: 'cl1', checkedInAt: null });
  });

  test('offboarding twice is a no-op', async () => {
    prisma.cleanerProfile.findFirst.mockResolvedValue({ ...profile, status: 'OFFBOARDED' });
    const result = await service.offboardCleaner('biz1', 'owner1', 'cl1', 'x');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.status).toBe('OFFBOARDED');
  });

  test('suspend only applies to active cleaners; reactivate only to suspended ones', async () => {
    prisma.cleanerProfile.findFirst.mockResolvedValue({ ...profile, status: 'OFFBOARDED' });
    await expect(service.suspendCleaner('biz1', 'o', 'cl1', 'x')).rejects.toMatchObject({ status: 409 });
    prisma.cleanerProfile.findFirst.mockResolvedValue({ ...profile, status: 'ACTIVE' });
    await expect(service.reactivateCleaner('biz1', 'o', 'cl1')).rejects.toMatchObject({ status: 409 });
  });

  test('reactivation respects the plan limit', async () => {
    prisma.cleanerProfile.findFirst.mockResolvedValue({ ...profile, status: 'SUSPENDED' });
    prisma.businessSubscription.findUnique.mockResolvedValue({ plan: { maxCleaners: 5 } });
    prisma.cleanerProfile.count.mockResolvedValue(5);
    await expect(service.reactivateCleaner('biz1', 'o', 'cl1')).rejects.toMatchObject({ status: 402 });
    expect(prisma.cleanerProfile.update).not.toHaveBeenCalled();
  });

  test('onboarding over the plan limit fails before any user is created or invited', async () => {
    prisma.businessSubscription.findUnique.mockResolvedValue({ plan: { maxCleaners: 2 } });
    prisma.cleanerProfile.count.mockResolvedValue(2);
    await expect(service.onboardCleaner('biz1', 'o', { firstName: 'A', lastName: 'B', email: 'a@b.nl' })).rejects.toMatchObject({ status: 402 });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(notifications.sendInvite).not.toHaveBeenCalled();
  });
});
