jest.mock('../src/config/database.js', () => ({
  recurringSchedule: { findMany: jest.fn(), update: jest.fn() },
  booking: { findFirst: jest.fn(), create: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({
  notifyBookingCreated: jest.fn().mockResolvedValue(undefined),
  notifyRecurringConflict: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/lib/pricing', () => ({ calculateQuote: jest.fn() }));

const prisma = require('../src/config/database.js');
const pricing = require('../src/lib/pricing');
const notifications = require('../src/modules/notifications/notifications.service');
const { processOnce } = require('../src/workers/recurringWorker');
const { advanceRunDate } = require('../src/utils/timezone');

const DAY = 24 * 3600 * 1000;
// Real nextRunDate values are aligned to the schedule's startTime (09:00 here, UTC).
const at9 = (daysFromNow) => {
  const d = new Date(Date.now() + daysFromNow * DAY);
  d.setUTCHours(9, 0, 0, 0);
  return d;
};

function schedule(overrides = {}) {
  return {
    id: 'rs1',
    businessId: 'biz1',
    customerId: 'c1',
    serviceId: 'svc1',
    frequency: 'WEEKLY',
    startTime: '09:00',
    nextRunDate: at9(2),
    business: { timezone: 'UTC' },
    customer: { addresses: [] },
    customerAddress: {
      line1: 'Damrak 1', city: 'Amsterdam', state: '', postalCode: '1012LG',
      accessCode: '4321', keyLocation: 'under mat', parkingInstructions: null, petNotes: 'cat', specialInstructions: null,
    },
    service: {
      id: 'svc1', estimatedMinutes: 120, basePriceCents: 8000,
      addOns: [{ id: 'a1', name: 'Oven', priceCents: 2500, extraMinutes: 30 }],
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.RECURRING_LOOKAHEAD_DAYS;
  prisma.recurringSchedule.update.mockResolvedValue({});
  pricing.calculateQuote.mockResolvedValue({ priceCents: 9450, breakdown: { estimatedMinutes: 150 } });
  prisma.booking.create.mockImplementation(async ({ data }) => ({ id: `bk-${data.scheduledStart.getTime()}`, ...data }));
  prisma.$transaction.mockImplementation(async (cb) => cb({ booking: { create: prisma.booking.create }, recurringSchedule: prisma.recurringSchedule }));
});

describe('recurring worker look-ahead', () => {
  test('creates every visit inside the window, not only ones that are already due', async () => {
    prisma.recurringSchedule.findMany.mockResolvedValue([schedule()]);
    // template lookup (1st findFirst) then conflict lookups (null)
    prisma.booking.findFirst.mockImplementation(async ({ where }) =>
      where.recurringScheduleId ? { addOns: [{ id: 'a1' }], homeDetails: { rooms: 3, bathrooms: 1 } } : null);

    const stats = await processOnce();

    // nextRunDate = now+2d, weekly, 21-day window -> now+2d, +9d, +16d
    expect(stats.created).toBe(3);
    expect(prisma.booking.create).toHaveBeenCalledTimes(3);
    const starts = prisma.booking.create.mock.calls.map((c) => c[0].data.scheduledStart.getTime());
    expect(starts[1] - starts[0]).toBe(7 * DAY);
  });

  test('a visit beyond the window is left for a later tick', async () => {
    prisma.recurringSchedule.findMany.mockResolvedValue([schedule({ nextRunDate: at9(30) })]);
    prisma.booking.findFirst.mockResolvedValue(null);
    // the DB query would not even return it, but the worker must also guard
    const stats = await processOnce();
    expect(stats.created).toBe(0);
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  test('query asks for schedules due within the horizon and skips inactive businesses', async () => {
    prisma.recurringSchedule.findMany.mockResolvedValue([]);
    await processOnce();
    const where = prisma.recurringSchedule.findMany.mock.calls[0][0].where;
    expect(where.business).toEqual({ isActive: true });
    expect(where.nextRunDate.lte.getTime()).toBeGreaterThan(Date.now() + 20 * DAY);
  });

  test('RECURRING_LOOKAHEAD_DAYS is honoured', async () => {
    process.env.RECURRING_LOOKAHEAD_DAYS = '8';
    prisma.recurringSchedule.findMany.mockResolvedValue([schedule()]);
    prisma.booking.findFirst.mockResolvedValue(null);
    const stats = await processOnce();
    expect(stats.created).toBe(1); // +2d only; +9d is outside an 8-day window
  });
});

describe('recurring booking content', () => {
  test('copies add-ons, home details, postcode and door/pet info, and re-prices without coupons', async () => {
    prisma.recurringSchedule.findMany.mockResolvedValue([schedule({ nextRunDate: at9(5) })]);
    prisma.booking.findFirst.mockImplementation(async ({ where }) =>
      where.recurringScheduleId
        ? { addOns: [{ id: 'a1' }, { id: 'gone' }], homeDetails: { rooms: 3, bathrooms: 2, sqft: 80 }, specialInstructions: 'dog at vet this week', quotedPriceCents: 100 }
        : null);

    await processOnce();

    const quoteArgs = pricing.calculateQuote.mock.calls[0][1];
    expect(quoteArgs).toMatchObject({ businessId: 'biz1', addOnIds: ['a1'], rooms: 3, bathrooms: 2, sqft: 80, frequency: 'WEEKLY' });
    expect(quoteArgs.couponCode).toBeUndefined();

    const data = prisma.booking.create.mock.calls[0][0].data;
    expect(data.quotedPriceCents).toBe(9450); // from calculateQuote, not the template's 100
    expect(data.postalCode).toBe('1012LG');
    expect(data.accessCode).toBe('4321');
    expect(data.keyLocation).toBe('under mat');
    expect(data.petNotes).toBe('cat');
    expect(data.addOns).toEqual([{ id: 'a1', name: 'Oven', priceCents: 2500, extraMinutes: 30 }]);
    expect(data.homeDetails).toMatchObject({ rooms: 3, frequency: 'WEEKLY' });
    expect(data.specialInstructions).toBeNull(); // one-off note not repeated
    expect(data.scheduledEnd.getTime() - data.scheduledStart.getTime()).toBe(150 * 60 * 1000); // quote duration
  });
});

describe('recurring worker edge cases', () => {
  test('occurrences in the past are skipped, not created', async () => {
    prisma.recurringSchedule.findMany.mockResolvedValue([schedule({ nextRunDate: at9(-3) })]);
    prisma.booking.findFirst.mockResolvedValue(null);
    const stats = await processOnce();
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    const created = prisma.booking.create.mock.calls.map((c) => c[0].data.scheduledStart.getTime());
    expect(created.every((t) => t > Date.now())).toBe(true);
  });

  test('a conflicting booking skips that visit and notifies the business', async () => {
    prisma.recurringSchedule.findMany.mockResolvedValue([schedule({ nextRunDate: at9(2) })]);
    let calls = 0;
    prisma.booking.findFirst.mockImplementation(async ({ where }) => {
      if (where.recurringScheduleId) return null;
      calls += 1;
      return calls === 1 ? { id: 'other' } : null;
    });
    const stats = await processOnce();
    expect(notifications.notifyRecurringConflict).toHaveBeenCalledTimes(1);
    expect(stats.skipped).toBe(1);
    expect(stats.created).toBe(2);
  });

  test('unique-constraint race (another replica) advances without failing', async () => {
    prisma.recurringSchedule.findMany.mockResolvedValue([schedule({ nextRunDate: at9(2) })]);
    prisma.booking.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    const stats = await processOnce();
    expect(stats.errors).toBe(0);
    expect(stats.skipped).toBe(1);
  });

  test('schedule with no address is advanced, not crashed', async () => {
    prisma.recurringSchedule.findMany.mockResolvedValue([schedule({ customerAddress: null })]);
    prisma.booking.findFirst.mockResolvedValue(null);
    const stats = await processOnce();
    expect(stats.created).toBe(0);
    expect(stats.errors).toBe(0);
  });
});

describe('advanceRunDate MONTHLY', () => {
  const from = (iso) => new Date(iso);
  test('Jan 31 -> Feb 28 (clamped, not Mar 3)', () => {
    const next = advanceRunDate(from('2026-01-31T09:00:00Z'), 'MONTHLY', '09:00', 'UTC');
    expect(next.toISOString()).toBe('2026-02-28T09:00:00.000Z');
  });
  test('Dec 15 -> Jan 15 next year', () => {
    const next = advanceRunDate(from('2026-12-15T09:00:00Z'), 'MONTHLY', '09:00', 'UTC');
    expect(next.toISOString()).toBe('2027-01-15T09:00:00.000Z');
  });
  test('keeps wall-clock time across DST in Amsterdam', () => {
    const next = advanceRunDate(from('2026-03-15T08:00:00Z'), 'MONTHLY', '09:00', 'Europe/Amsterdam'); // 09:00 CET
    expect(next.toISOString()).toBe('2026-04-15T07:00:00.000Z'); // 09:00 CEST
  });
});
