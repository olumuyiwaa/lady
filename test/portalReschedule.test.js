jest.mock('../src/config/database.js', () => {
  const db = {
    booking: { findFirst: jest.fn(), update: jest.fn() },
    business: { findUnique: jest.fn() },
    businessHours: { findMany: jest.fn() },
    bookingAssignment: { findMany: jest.fn(), deleteMany: jest.fn() },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  db.$transaction = jest.fn((fn) => fn(db));
  return db;
});
jest.mock('../src/lib/notificationClient', () => ({ sendSms: jest.fn(), sendEmail: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({ createRefund: jest.fn(), createAncillaryCheckoutSession: jest.fn() }));
jest.mock('../src/lib/capacity', () => ({ spareCapacity: jest.fn() }));
jest.mock('../src/lib/assignmentConflicts', () => ({ assertCleanerFree: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({ notifyBookingRescheduled: jest.fn() }));

const prisma = require('../src/config/database.js');
const { spareCapacity } = require('../src/lib/capacity');
const { assertCleanerFree } = require('../src/lib/assignmentConflicts');
const notifications = require('../src/modules/notifications/notifications.service');
const service = require('../src/modules/customerPortal/customerPortal.service');

// Monday 2099-06-01 10:00 Amsterdam
const MON_10 = '2099-06-01T08:00:00.000Z';
const hours = [{ dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isClosed: false }];
const booking = (over = {}) => ({
  id: 'bk1', status: 'CONFIRMED', latitude: 1, longitude: 2,
  scheduledStart: new Date('2099-06-02T08:00:00Z'), scheduledEnd: new Date('2099-06-02T10:00:00Z'), ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
  prisma.$executeRaw.mockResolvedValue(1);
  prisma.business.findUnique.mockResolvedValue({ timezone: 'Europe/Amsterdam' });
  prisma.businessHours.findMany.mockResolvedValue(hours);
  prisma.booking.findFirst.mockResolvedValue(booking());
  prisma.booking.update.mockImplementation(async ({ data }) => ({ ...booking(), ...data }));
  prisma.bookingAssignment.findMany.mockResolvedValue([]);
  spareCapacity.mockResolvedValue({ spare: 1 });
});

describe('customer portal reschedule', () => {
  test('moves the booking, resets the reminder and tells the business', async () => {
    const r = await service.rescheduleMyBooking('biz', 'c1', 'bk1', { scheduledStart: MON_10 });
    expect(prisma.booking.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ scheduledStart: new Date(MON_10), reminderSentAt: null }),
    }));
    expect(notifications.notifyBookingRescheduled).toHaveBeenCalledWith('biz', expect.objectContaining({ id: 'bk1' }));
    expect(r.scheduledStart).toEqual(new Date(MON_10));
  });

  test('refuses a time outside opening hours (Sunday / 03:00)', async () => {
    await expect(service.rescheduleMyBooking('biz', 'c1', 'bk1', { scheduledStart: '2099-05-31T08:00:00.000Z' })).rejects.toMatchObject({ status: 422 });
    await expect(service.rescheduleMyBooking('biz', 'c1', 'bk1', { scheduledStart: '2099-06-01T01:00:00.000Z' })).rejects.toMatchObject({ status: 422 });
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('uses the same capacity rule as the widget and ignores the booking\'s own old slot', async () => {
    await service.rescheduleMyBooking('biz', 'c1', 'bk1', { scheduledStart: MON_10 });
    expect(spareCapacity).toHaveBeenCalledWith('biz', new Date(MON_10), expect.any(Date), expect.objectContaining({ excludeBookingId: 'bk1' }));
    spareCapacity.mockResolvedValue({ spare: 0 });
    await expect(service.rescheduleMyBooking('biz', 'c1', 'bk1', { scheduledStart: MON_10 })).rejects.toMatchObject({ status: 422, message: 'No availability at the requested time' });
  });

  test('is serialised with widget bookings by the per-business lock', async () => {
    await service.rescheduleMyBooking('biz', 'c1', 'bk1', { scheduledStart: MON_10 });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  test('keeps the assigned cleaner when they are free at the new time', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ status: 'ASSIGNED' }));
    prisma.bookingAssignment.findMany.mockResolvedValue([{ id: 'as1', cleanerId: 'cl1' }]);
    assertCleanerFree.mockResolvedValue(undefined);
    await service.rescheduleMyBooking('biz', 'c1', 'bk1', { scheduledStart: MON_10 });
    expect(prisma.bookingAssignment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.booking.update.mock.calls[0][0].data.status).toBe('ASSIGNED');
  });

  test('releases the cleaner (and returns to CONFIRMED) when they are busy at the new time', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ status: 'ASSIGNED' }));
    prisma.bookingAssignment.findMany.mockResolvedValue([{ id: 'as1', cleanerId: 'cl1' }]);
    assertCleanerFree.mockRejectedValue(Object.assign(new Error('busy'), { status: 409 }));
    await service.rescheduleMyBooking('biz', 'c1', 'bk1', { scheduledStart: MON_10 });
    expect(prisma.bookingAssignment.deleteMany).toHaveBeenCalledWith({ where: { bookingId: 'bk1' } });
    expect(prisma.booking.update.mock.calls[0][0].data.status).toBe('CONFIRMED');
  });

  test.each(['COMPLETED', 'CANCELLED', 'IN_PROGRESS'])('a %s booking cannot be rescheduled', async (status) => {
    prisma.booking.findFirst.mockResolvedValue(booking({ status }));
    await expect(service.rescheduleMyBooking('biz', 'c1', 'bk1', { scheduledStart: MON_10 })).rejects.toMatchObject({ status: 422 });
  });
});
