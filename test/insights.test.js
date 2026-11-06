jest.mock('../src/config/database', () => ({
  business: { findUnique: jest.fn() },
  booking: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  review: { findMany: jest.fn() },
  cleanerProfile: { findMany: jest.fn() },
}));
const prisma = require('../src/config/database');
const { buildInsights } = require('../src/lib/insights');
const reports = require('../src/modules/reports/reports.service');

// 2026-11-09 is a Monday, 11-10 Tuesday (Amsterdam = UTC+1 in November)
const at = (day, h) => new Date(Date.UTC(2026, 10, day, h - 1));
const bk = (o) => ({ id: Math.random().toString(36), customerId: 'c1', serviceName: 'Standard', quotedPriceCents: 10000, scheduledStart: at(9, 9), scheduledEnd: at(9, 11), assignments: [{ cleanerId: 'k1', checkedInAt: at(9, 9) }], ...o });

describe('buildInsights', () => {
  test('revenue, averages and change vs the previous period', () => {
    const r = buildInsights({ bookings: [bk({}), bk({ quotedPriceCents: 20000 })], previous: [{ quotedPriceCents: 10000 }], from: at(1, 0) });
    expect(r).toMatchObject({ bookings: 2, revenueCents: 30000, avgBookingCents: 15000, revenueChangePct: 200 });
    expect(r.findings.map((f) => f.key)).toContain('REVENUE_UP');
  });

  test('weekday and hour demand use the business timezone', () => {
    const r = buildInsights({ bookings: [bk({ scheduledStart: at(9, 9) }), bk({ scheduledStart: at(10, 14) })], from: at(1, 0) });
    expect(r.byWeekday[1].bookings).toBe(1); // Monday
    expect(r.byWeekday[2].bookings).toBe(1); // Tuesday
    expect(r.byHour[9]).toBe(1);
    expect(r.byHour[14]).toBe(1);
  });

  test('new vs returning customers', () => {
    const r = buildInsights({
      bookings: [bk({ customerId: 'old' }), bk({ customerId: 'new' })],
      firstSeen: { old: at(1, 0).getTime() - 864e5 * 90, new: at(5, 0) },
      from: at(1, 0),
    });
    expect(r.customers).toEqual({ total: 2, new: 1, returning: 1, returningRate: 50 });
  });

  test('per-cleaner jobs, hours, split revenue, rating and punctuality', () => {
    const r = buildInsights({
      bookings: [
        bk({ assignments: [{ cleanerId: 'k1', checkedInAt: at(9, 9) }, { cleanerId: 'k2', checkedInAt: new Date(at(9, 9).getTime() + 30 * 60000) }] }),
      ],
      reviews: [{ cleanerId: 'k1', rating: 5 }, { cleanerId: 'k1', rating: 4 }],
      cleanerNames: { k1: 'Eva', k2: 'Tom' },
      from: at(1, 0),
    });
    const k1 = r.cleaners.find((c) => c.cleanerId === 'k1');
    const k2 = r.cleaners.find((c) => c.cleanerId === 'k2');
    expect(k1).toMatchObject({ name: 'Eva', jobs: 1, hours: 2, revenueCents: 5000, avgRating: 4.5, ratings: 2, onTimeRate: 100 });
    expect(k2).toMatchObject({ onTimeRate: 0, avgRating: null });
  });

  test('findings need enough data and call out real problems', () => {
    const few = buildInsights({ bookings: [bk({})], from: at(1, 0) });
    expect(few.findings).toEqual([{ key: 'UNASSIGNED', params: { count: 0 } }].filter(() => false));
    const many = Array.from({ length: 12 }, (_, i) => bk({ customerId: `c${i}`, scheduledStart: at(9, 9), assignments: [] }));
    const r = buildInsights({ bookings: many, cancelledCount: 6, previous: many.slice(0, 10), previousCancelledCount: 0, firstSeen: {}, from: at(1, 0) });
    const keys = r.findings.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['BUSIEST_WEEKDAY', 'CANCELLATIONS_UP', 'UNASSIGNED']));
    expect(r.cancelRate).toBeCloseTo(33.3, 1);
    expect(r.unassigned).toBe(12);
  });

  test('empty range is safe', () => {
    const r = buildInsights({ bookings: [], from: at(1, 0) });
    expect(r).toMatchObject({ bookings: 0, revenueCents: 0, avgBookingCents: 0, cancelRate: null, revenueChangePct: null });
    expect(r.findings).toEqual([]);
  });
});

describe('reports.getInsights', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.business.findUnique.mockResolvedValue({ timezone: 'Europe/Amsterdam' });
    prisma.booking.findMany.mockResolvedValue([{ id: 'b', customerId: 'c1', status: 'COMPLETED', scheduledStart: at(9, 9), scheduledEnd: at(9, 11), quotedPriceCents: 10000, service: { name: 'Standard' }, assignments: [{ cleanerId: 'k1', checkedInAt: at(9, 9) }] }]);
    prisma.booking.count.mockResolvedValue(0);
    prisma.booking.groupBy.mockResolvedValue([{ customerId: 'c1', _min: { scheduledStart: at(1, 0) } }]);
    prisma.review.findMany.mockResolvedValue([]);
    prisma.cleanerProfile.findMany.mockResolvedValue([{ id: 'k1', user: { firstName: 'Eva', lastName: 'D' } }]);
  });
  test('loads, scopes to the business and returns the range', async () => {
    const r = await reports.getInsights('biz', { from: '2026-11-01', to: '2026-11-30' });
    expect(r).toMatchObject({ bookings: 1, revenueCents: 10000 });
    expect(r.cleaners[0].name).toBe('Eva D');
    for (const call of prisma.booking.findMany.mock.calls) expect(call[0].where.businessId).toBe('biz');
  });
  test('rejects a bad or huge range', async () => {
    await expect(reports.getInsights('biz', { from: '2026-11-30', to: '2026-11-01' })).rejects.toMatchObject({ status: 422 });
    await expect(reports.getInsights('biz', { from: '2020-01-01', to: '2026-11-01' })).rejects.toMatchObject({ status: 422 });
  });
});
