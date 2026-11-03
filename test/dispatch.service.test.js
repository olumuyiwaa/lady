jest.mock('../src/config/database.js', () => ({
  booking: { findFirst: jest.fn(), update: jest.fn() },
  cleanerProfile: { findFirst: jest.fn(), findUnique: jest.fn() },
  bookingAssignment: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn().mockResolvedValue(null), count: jest.fn(), delete: jest.fn() },
  businessSubscription: { findUnique: jest.fn() },
}));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({ notifyCleanerAssigned: jest.fn(), notifyCleanerUnassigned: jest.fn() }));
jest.mock('../src/lib/scheduler', () => ({ findAvailableCleaners: jest.fn() }));

const mockPrisma = require('../src/config/database.js');
const scheduler = require('../src/lib/scheduler');
const dispatchService = require('../src/modules/dispatch/dispatch.service');

describe('dispatch.service.createAssignment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const booking = {
    id: 'bk1',
    status: 'CONFIRMED',
    scheduledStart: new Date('2026-01-01T10:00:00Z'),
    scheduledEnd: new Date('2026-01-01T12:00:00Z'),
    latitude: 1,
    longitude: 2,
  };

  test('404s when the booking does not exist for this business', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(null);
    await expect(dispatchService.createAssignment('biz1', 'missing', null, 'user1')).rejects.toMatchObject({
      status: 404,
    });
  });

  test('manual assignment rejects a cleaner not active for this business', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.cleanerProfile.findFirst.mockResolvedValue(null);
    await expect(dispatchService.createAssignment('biz1', 'bk1', 'cleaner-x', 'user1')).rejects.toMatchObject({
      status: 404,
    });
    expect(scheduler.findAvailableCleaners).not.toHaveBeenCalled();
  });

  test('auto-pick uses the top-ranked scheduler candidate and assigns them', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    scheduler.findAvailableCleaners.mockResolvedValue([
      { cleaner: { id: 'cleaner-best' }, distanceMeters: 500, etaSeconds: 300, locationSource: 'gps', workload: 2 },
      { cleaner: { id: 'cleaner-second' }, distanceMeters: 5000, etaSeconds: 900, locationSource: 'gps', workload: 1 },
    ]);
    mockPrisma.bookingAssignment.create.mockResolvedValue({ id: 'assign1', bookingId: 'bk1', cleanerId: 'cleaner-best' });

    const result = await dispatchService.createAssignment('biz1', 'bk1', null, 'user1');

    expect(scheduler.findAvailableCleaners).toHaveBeenCalledWith(
      'biz1',
      booking.scheduledStart,
      booking.scheduledEnd,
      expect.objectContaining({ lat: 1, lng: 2, includeEta: true })
    );
    expect(mockPrisma.bookingAssignment.create).toHaveBeenCalledWith({
      data: { bookingId: 'bk1', cleanerId: 'cleaner-best', isTeamLead: false },
    });
    expect(mockPrisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'bk1' },
      data: { status: 'ASSIGNED' },
    });
    expect(result.cleanerId).toBe('cleaner-best');
  });

  test('auto-pick with no available cleaners raises a 409, not a silent no-op', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    scheduler.findAvailableCleaners.mockResolvedValue([]);
    await expect(dispatchService.createAssignment('biz1', 'bk1', null, 'user1')).rejects.toMatchObject({
      status: 409,
    });
    expect(mockPrisma.bookingAssignment.create).not.toHaveBeenCalled();
  });

  test('auto-pick is blocked with a 402 when the business plan has autoDispatch disabled', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.businessSubscription.findUnique.mockResolvedValue({
      plan: { features: { autoDispatch: false } },
    });
    await expect(dispatchService.createAssignment('biz1', 'bk1', null, 'user1')).rejects.toMatchObject({
      status: 402,
    });
    expect(scheduler.findAvailableCleaners).not.toHaveBeenCalled();
  });

  test('manual assignment (explicit cleanerId) is unaffected by the autoDispatch plan gate', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    mockPrisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'cleaner-x', businessId: 'biz1', status: 'ACTIVE' });
    mockPrisma.businessSubscription.findUnique.mockResolvedValue({
      plan: { features: { autoDispatch: false } },
    });
    mockPrisma.bookingAssignment.create.mockResolvedValue({ id: 'assign1', bookingId: 'bk1', cleanerId: 'cleaner-x' });

    const result = await dispatchService.createAssignment('biz1', 'bk1', 'cleaner-x', 'user1');

    expect(result.cleanerId).toBe('cleaner-x');
    expect(scheduler.findAvailableCleaners).not.toHaveBeenCalled();
  });
});
