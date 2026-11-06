jest.mock('../src/config/database', () => ({
  business: { findUnique: jest.fn() },
  booking: { findMany: jest.fn() },
  cleanerProfile: { findMany: jest.fn() },
  bookingAssignment: { findMany: jest.fn() },
}));
const mockCreate = jest.fn();
jest.mock('../src/modules/dispatch/dispatch.service', () => ({ createAssignment: (...a) => mockCreate(...a) }));
const mockFree = jest.fn();
jest.mock('../src/lib/scheduler', () => ({ findAvailableCleaners: (...a) => mockFree(...a) }));
const prisma = require('../src/config/database');
const { planForDate, applyPlan } = require('../src/modules/dispatch/dispatch.plan');

const T = (h) => new Date(Date.UTC(2026, 10, 9, h - 1)); // Amsterdam winter time
const job = (id, sh, eh, lat, lng) => ({ id, scheduledStart: T(sh), scheduledEnd: T(eh), latitude: lat, longitude: lng, addressLine1: 'Dam 1', city: 'Amsterdam', customer: { firstName: 'Ann', lastName: 'B' } });
const cleaner = (id) => ({ id, user: { firstName: id, lastName: '' } });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.business.findUnique.mockResolvedValue({ timezone: 'Europe/Amsterdam' });
  prisma.cleanerProfile.findMany.mockResolvedValue([cleaner('B'), cleaner('A')]);
  prisma.bookingAssignment.findMany.mockResolvedValue([
    { cleanerId: 'A', booking: job('a1', 8, 10, 52.3791, 4.9003) },
    { cleanerId: 'B', booking: job('b1', 8, 10, 52.0907, 5.1214) },
  ]);
  prisma.booking.findMany.mockResolvedValue([job('j1', 12, 14, 52.3389, 4.8729)]);
  mockFree.mockResolvedValue([cleaner('A'), cleaner('B')]);
});

describe('planForDate', () => {
  test('proposes the cleaner closest to the job and reports the saving', async () => {
    const r = await planForDate('biz', '2026-11-09');
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0]).toMatchObject({ bookingId: 'j1', cleanerId: 'A', customerName: 'Ann B' });
    expect(r.savedKm).toBeGreaterThan(30);
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ businessId: 'biz', assignments: { none: {} } });
    expect(where.scheduledStart.gte.toISOString()).toBe('2026-11-08T23:00:00.000Z');
    expect(where.scheduledStart.lt.toISOString()).toBe('2026-11-09T23:00:00.000Z');
  });
  test('only considers cleaners the scheduler says are free', async () => {
    mockFree.mockResolvedValue([cleaner('B')]);
    expect((await planForDate('biz', '2026-11-09')).assignments[0].cleanerId).toBe('B');
  });
  test('nothing to plan, and bad dates', async () => {
    prisma.booking.findMany.mockResolvedValue([]);
    expect(await planForDate('biz', '2026-11-09')).toMatchObject({ jobs: 0, assignments: [] });
    await expect(planForDate('biz', 'tomorrow')).rejects.toMatchObject({ status: 422 });
  });
});

describe('applyPlan', () => {
  test('applies each assignment and reports failures individually', async () => {
    mockCreate.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Cleaner already booked'));
    const r = await applyPlan('biz', [{ bookingId: 'j1', cleanerId: 'A' }, { bookingId: 'j2', cleanerId: 'A' }], 'u1');
    expect(r).toMatchObject({ applied: 1, failed: 1 });
    expect(r.results[1]).toEqual({ bookingId: 'j2', ok: false, error: 'Cleaner already booked' });
    expect(mockCreate).toHaveBeenCalledWith('biz', 'j1', 'A', 'u1');
  });
  test('rejects empty input', async () => {
    await expect(applyPlan('biz', [], 'u')).rejects.toMatchObject({ status: 422 });
  });
});
