jest.mock('../src/config/database.js', () => ({
  transaction: { upsert: jest.fn(), updateMany: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  business: { findUnique: jest.fn() },
  customer: { findUnique: jest.fn() },
  cleanerProfile: { findUnique: jest.fn() },
}));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const prisma = require('../src/config/database.js');
const logger = require('../src/config/logger');
const svc = require('../src/modules/transactions/transactions.service');

const row = (over = {}) => ({
  businessId: 'biz1', type: 'DEPOSIT', direction: 'IN', status: 'SUCCEEDED', method: 'STRIPE',
  amountCents: 2000, currency: 'EUR', occurredAt: new Date('2026-05-01T10:00:00Z'),
  counterpartyName: 'Anna', dedupeKey: 'deposit:bk1', ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  prisma.business.findUnique.mockResolvedValue({ timezone: 'Europe/Amsterdam', currency: 'EUR' });
  prisma.transaction.upsert.mockResolvedValue({});
});

describe('record()', () => {
  test('upserts by dedupeKey with an empty update, so a repeat delivery changes nothing', async () => {
    expect(await svc.record(row())).toBe(true);
    const arg = prisma.transaction.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ dedupeKey: 'deposit:bk1' });
    expect(arg.update).toEqual({});
    expect(arg.create).toMatchObject({ businessId: 'biz1', amountCents: 2000 });
  });

  test('updateOnConflict moves status, date and amount only, nothing else', async () => {
    await svc.record(row({ status: 'SUCCEEDED', description: 'x' }), { updateOnConflict: true });
    expect(Object.keys(prisma.transaction.upsert.mock.calls[0][0].update).sort()).toEqual(['amountCents', 'occurredAt', 'status']);
  });

  test('NEVER throws: a database failure is logged and reported as false', async () => {
    prisma.transaction.upsert.mockRejectedValue(new Error('db down'));
    await expect(svc.record(row())).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith('transaction log write failed', expect.objectContaining({ dedupeKey: 'deposit:bk1', message: 'db down' }));
  });

  test('a unique-key race (P2002) means another delivery already wrote it: success, no error log', async () => {
    prisma.transaction.upsert.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(svc.record(row())).resolves.toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test.each([[0], [-5], [12.5], [null], ['2000']])('amount %p is not a money movement and is not written', async (amountCents) => {
    expect(await svc.record(row({ amountCents }))).toBe(false);
    expect(prisma.transaction.upsert).not.toHaveBeenCalled();
  });

  test('a row without businessId or dedupeKey is refused (it could never be found again)', async () => {
    expect(await svc.record(row({ businessId: undefined }))).toBe(false);
    expect(await svc.record(row({ dedupeKey: undefined }))).toBe(false);
    expect(await svc.record(null)).toBe(false);
    expect(prisma.transaction.upsert).not.toHaveBeenCalled();
  });

  test('currency falls back to the business currency, then EUR', async () => {
    prisma.business.findUnique.mockResolvedValue({ currency: 'gbp' });
    await svc.record(row({ currency: null }));
    expect(prisma.transaction.upsert.mock.calls[0][0].create.currency).toBe('GBP');
    prisma.business.findUnique.mockRejectedValue(new Error('x'));
    await svc.record(row({ currency: null, dedupeKey: 'k2' }));
    expect(prisma.transaction.upsert.mock.calls[1][0].create.currency).toBe('EUR');
  });

  test('a missing counterparty name is snapshotted from the customer, or the cleaner', async () => {
    prisma.customer.findUnique.mockResolvedValue({ firstName: 'Anna', lastName: 'de Vries' });
    await svc.record(row({ counterpartyName: null, customerId: 'c1' }));
    expect(prisma.transaction.upsert.mock.calls[0][0].create.counterpartyName).toBe('Anna de Vries');

    prisma.cleanerProfile.findUnique.mockResolvedValue({ user: { firstName: 'Ada', lastName: 'Okafor' } });
    await svc.record(row({ counterpartyName: null, customerId: null, cleanerId: 'cl1', dedupeKey: 'k3' }));
    expect(prisma.transaction.upsert.mock.calls[1][0].create.counterpartyName).toBe('Ada Okafor');
  });

  test('a failed name lookup never stops the money being recorded', async () => {
    prisma.customer.findUnique.mockRejectedValue(new Error('x'));
    await expect(svc.record(row({ counterpartyName: null, customerId: 'c1' }))).resolves.toBe(true);
  });

  test('reverseManualPayments touches only hand-recorded, still-SUCCEEDED payments, never Stripe ones', async () => {
    await svc.reverseManualPayments('bk1');
    expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
      where: { bookingId: 'bk1', type: 'BOOKING_PAYMENT', method: { not: 'STRIPE' }, status: 'SUCCEEDED' },
      data: { status: 'REVERSED' },
    });
  });
});

describe('buildWhere(): tenant isolation', () => {
  test("a business's scope cannot be widened or redirected by the query string", () => {
    const where = svc.buildWhere({ businessId: 'biz1' }, { businessId: 'OTHER', q: 'x' }, 'Europe/Amsterdam');
    expect(where.businessId).toBe('biz1');
  });

  test('the platform admin sees everything unless they narrow with businessId', () => {
    expect(svc.buildWhere({}, {}, 'UTC').businessId).toBeUndefined();
    expect(svc.buildWhere({}, { businessId: 'biz9' }, 'UTC').businessId).toBe('biz9');
  });
});

describe('buildWhere(): filters', () => {
  const where = (f) => svc.buildWhere({ businessId: 'biz1' }, f, 'Europe/Amsterdam');

  test('comma-separated enum lists, case-insensitive', () => {
    expect(where({ type: 'deposit,tip', direction: 'in', status: 'FAILED', method: 'cash' })).toMatchObject({
      type: { in: ['DEPOSIT', 'TIP'] }, direction: { in: ['IN'] }, status: { in: ['FAILED'] }, method: { in: ['CASH'] },
    });
  });

  test.each([['type', 'LOTTERY'], ['direction', 'SIDEWAYS'], ['status', 'MAYBE'], ['method', 'BITCOIN']])('an unknown %s is a 422, not silently ignored', (key, value) => {
    expect(() => where({ [key]: value })).toThrow(expect.objectContaining({ status: 422 }));
  });

  test('empty filters add nothing', () => {
    expect(where({})).toEqual({ businessId: 'biz1' });
    expect(where({ type: '', q: '   ' })).toEqual({ businessId: 'biz1' });
  });

  test('search covers text fields (insensitive) and Stripe ids / booking id (exact)', () => {
    const or = where({ q: ' Anna ' }).OR;
    expect(or).toEqual(expect.arrayContaining([
      { counterpartyName: { contains: 'Anna', mode: 'insensitive' } },
      { description: { contains: 'Anna', mode: 'insensitive' } },
      { stripePaymentIntentId: 'Anna' },
      { bookingId: 'Anna' },
    ]));
  });

  test('search text is capped', () => {
    expect(where({ q: 'a'.repeat(500) }).OR[0].description.contains).toHaveLength(100);
  });
});

describe('date ranges follow the business-local day', () => {
  const range = (from, to, tz = 'Europe/Amsterdam') => svc.parseRange(from, to, tz);

  test('summer: midnight Amsterdam is 22:00 UTC the day before; "to" includes the whole day', () => {
    const r = range('2026-07-01', '2026-07-01');
    expect(r.gte.toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(r.lt.toISOString()).toBe('2026-07-01T22:00:00.000Z');
  });

  test('a payment at 00:30 local on the 1st lands in the 1st, not the 31st', () => {
    const r = range('2026-07-01', '2026-07-01');
    const paid = new Date('2026-06-30T22:30:00Z'); // 00:30 CEST on 1 July
    expect(paid >= r.gte && paid < r.lt).toBe(true);
  });

  test('the day clocks go forward (2026-03-29) is 23 hours long, handled correctly', () => {
    const r = range('2026-03-29', '2026-03-29');
    expect(r.gte.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(r.lt.toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });

  test('a full timestamp is used exactly as given', () => {
    const r = range('2026-07-01T08:00:00Z', '2026-07-01T09:00:00Z');
    expect(r.gte.toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(r.lte.toISOString()).toBe('2026-07-01T09:00:00.000Z');
  });

  test('from only, to only, and neither', () => {
    expect(range('2026-07-01', undefined)).toEqual({ gte: expect.any(Date) });
    expect(range(undefined, '2026-07-01')).toEqual({ lt: expect.any(Date) });
    expect(range(undefined, undefined)).toBeUndefined();
  });

  test('invalid or reversed ranges are a 422', () => {
    expect(() => range('not-a-date', undefined)).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => range(undefined, '2026-13-45')).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => range('2026-08-01', '2026-07-01')).toThrow(expect.objectContaining({ status: 422 }));
  });

  test('a date that does not exist is rejected, not silently moved to another day', () => {
    for (const bad of ['2026-02-30', '2026-04-31', '2025-02-29', '2026-00-10', '2026-06-00']) {
      expect(() => range(bad, undefined)).toThrow(expect.objectContaining({ status: 422 }));
      expect(() => range(undefined, bad)).toThrow(expect.objectContaining({ status: 422 }));
    }
    expect(range('2028-02-29', undefined).gte).toBeInstanceOf(Date); // a real leap day is fine
  });

  test('an invalid business timezone falls back to Amsterdam instead of crashing', () => {
    expect(range('2026-07-01', undefined, 'Not/AZone').gte.toISOString()).toBe('2026-06-30T22:00:00.000Z');
  });
});

describe('list()', () => {
  beforeEach(() => {
    prisma.transaction.findMany.mockResolvedValue([{ id: 't2', ...row(), backfilled: false, metadata: null }]);
    prisma.transaction.count.mockResolvedValue(51);
  });

  test('scopes to the business, orders newest first with a stable tie-break, and paginates', async () => {
    const out = await svc.list({ businessId: 'biz1' }, { page: '2', limit: '20' });
    const args = prisma.transaction.findMany.mock.calls[0][0];
    expect(args.where.businessId).toBe('biz1');
    expect(args.orderBy).toEqual([{ occurredAt: 'desc' }, { id: 'desc' }]);
    expect(args).toMatchObject({ skip: 20, take: 20 });
    expect(out.pagination).toEqual({ page: 2, limit: 20, total: 51, totalPages: 3 });
  });

  test('limit is clamped to 100 and page to at least 1', async () => {
    await svc.list({ businessId: 'biz1' }, { page: '-3', limit: '9999' });
    expect(prisma.transaction.findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 100 });
  });

  test('only whitelisted sort fields are accepted', async () => {
    await svc.list({ businessId: 'biz1' }, { sort: 'dedupeKey; DROP TABLE', order: 'asc' });
    expect(prisma.transaction.findMany.mock.calls[0][0].orderBy[0]).toEqual({ occurredAt: 'asc' });
    await svc.list({ businessId: 'biz1' }, { sort: 'amountCents' });
    expect(prisma.transaction.findMany.mock.calls[1][0].orderBy[0]).toEqual({ amountCents: 'desc' });
  });

  test('business view does not join the business; the admin view does', async () => {
    await svc.list({ businessId: 'biz1' }, {});
    expect(prisma.transaction.findMany.mock.calls[0][0].include).toBeUndefined();
    await svc.list({}, {});
    expect(prisma.transaction.findMany.mock.calls[1][0].include).toEqual({ business: { select: { id: true, name: true, subdomain: true } } });
  });

  test('the response never exposes internal fields', async () => {
    const { items } = await svc.list({ businessId: 'biz1' }, {});
    expect(Object.keys(items[0])).not.toEqual(expect.arrayContaining(['dedupeKey', 'metadata', 'backfilled', 'businessId']));
  });

  test('rebuilt rows are flagged approximate; live rows are not', async () => {
    prisma.transaction.findMany.mockResolvedValue([
      { id: 'a', ...row(), backfilled: true, metadata: { dateApproximate: true } },
      { id: 'b', ...row(), backfilled: true, metadata: null },
      { id: 'c', ...row(), backfilled: false, metadata: { dateApproximate: true } },
    ]);
    const { items } = await svc.list({ businessId: 'biz1' }, {});
    expect(items.map((i) => i.approximate)).toEqual([true, false, false]);
  });
});

describe('summary()', () => {
  const g = (currency, type, direction, status, method, amount, count = 1) => ({ currency, type, direction, status, method, _sum: { amountCents: amount }, _count: { _all: count } });

  test('only SUCCEEDED money counts; net = in - out', () => {
    const out = svc.foldSummary([
      g('EUR', 'DEPOSIT', 'IN', 'SUCCEEDED', 'STRIPE', 20000, 4),
      g('EUR', 'BOOKING_PAYMENT', 'IN', 'SUCCEEDED', 'CASH', 5000, 2),
      g('EUR', 'REFUND', 'OUT', 'SUCCEEDED', 'STRIPE', 3000, 1),
      g('EUR', 'CLEANER_PAYOUT', 'OUT', 'SUCCEEDED', 'BANK_TRANSFER', 7000, 1),
    ], { platform: false });
    expect(out.byCurrency).toHaveLength(1);
    expect(out.byCurrency[0]).toMatchObject({ currency: 'EUR', inCents: 25000, outCents: 10000, netCents: 15000, count: 8 });
    expect(out.byCurrency[0].byType.DEPOSIT).toEqual({ count: 4, amountCents: 20000 });
  });

  test('PENDING is held aside, FAILED is only counted, REVERSED moves no money', () => {
    const [r] = svc.foldSummary([
      g('EUR', 'DEPOSIT', 'IN', 'SUCCEEDED', 'STRIPE', 1000),
      g('EUR', 'DISPUTE', 'OUT', 'PENDING', 'STRIPE', 4000),
      g('EUR', 'SUBSCRIPTION', 'OUT', 'FAILED', 'STRIPE', 2900, 2),
      g('EUR', 'DISPUTE', 'OUT', 'REVERSED', 'STRIPE', 9000),
    ], { platform: false }).byCurrency;
    expect(r).toMatchObject({ inCents: 1000, outCents: 0, netCents: 1000, pendingOutCents: 4000, failedCount: 2, count: 5 });
  });

  test('currencies are never added together', () => {
    const { byCurrency } = svc.foldSummary([
      g('GBP', 'DEPOSIT', 'IN', 'SUCCEEDED', 'STRIPE', 1000),
      g('EUR', 'DEPOSIT', 'IN', 'SUCCEEDED', 'STRIPE', 2000),
    ], { platform: false });
    expect(byCurrency.map((c) => [c.currency, c.inCents])).toEqual([['EUR', 2000], ['GBP', 1000]]);
  });

  test('platform view: subscription revenue, Stripe volume, refunds, open disputes, failed subscriptions', () => {
    const [r] = svc.foldSummary([
      g('EUR', 'SUBSCRIPTION', 'OUT', 'SUCCEEDED', 'STRIPE', 5800, 2),
      g('EUR', 'SUBSCRIPTION', 'OUT', 'FAILED', 'STRIPE', 2900, 1),
      g('EUR', 'DEPOSIT', 'IN', 'SUCCEEDED', 'STRIPE', 10000),
      g('EUR', 'BOOKING_PAYMENT', 'IN', 'SUCCEEDED', 'CASH', 9999), // cash never touched Stripe
      g('EUR', 'REFUND', 'OUT', 'SUCCEEDED', 'STRIPE', 1500),
      g('EUR', 'DISPUTE', 'OUT', 'PENDING', 'STRIPE', 4000, 3),
    ], { platform: true }).byCurrency;
    expect(r).toMatchObject({ subscriptionRevenueCents: 5800, stripeVolumeInCents: 10000, refundedCents: 1500, openDisputes: 3, failedSubscriptionPayments: 1 });
  });

  test('an empty result is an empty list, not an error', () => {
    expect(svc.foldSummary([], { platform: false })).toEqual({ byCurrency: [] });
  });

  test('summary() uses the same filters as the list', async () => {
    prisma.transaction.groupBy.mockResolvedValue([]);
    await svc.summary({ businessId: 'biz1' }, { type: 'TIP', from: '2026-07-01' });
    const args = prisma.transaction.groupBy.mock.calls[0][0];
    expect(args.where).toMatchObject({ businessId: 'biz1', type: { in: ['TIP'] }, occurredAt: { gte: new Date('2026-06-30T22:00:00Z') } });
    expect(args.by).toEqual(['currency', 'type', 'direction', 'status', 'method']);
  });
});

describe('exportRows()', () => {
  const full = (over = {}) => ({ id: 'x', ...row(), description: 'Deposit', reference: null, bookingId: 'bk1', business: { name: 'Acme' }, backfilled: false, metadata: null, ...over });

  test('amounts are numbers, signed by direction, so a spreadsheet column sums to net', async () => {
    prisma.transaction.findMany.mockResolvedValue([full({ amountCents: 2050 }), full({ direction: 'OUT', amountCents: 1000, type: 'REFUND' })]);
    const rows = await svc.exportRows({ businessId: 'biz1' }, {});
    expect(rows.map((r) => r.amount)).toEqual([20.5, -10]);
    expect(rows.every((r) => typeof r.amount === 'number')).toBe(true);
    expect(rows[0].date).toBe('2026-05-01T10:00:00.000Z');
  });

  test('text a customer typed cannot become a spreadsheet formula', async () => {
    prisma.transaction.findMany.mockResolvedValue([full({ counterpartyName: '=HYPERLINK("http://evil")', description: '+cmd', reference: '-1+1', ref2: '@x' })]);
    const [r] = await svc.exportRows({ businessId: 'biz1' }, {});
    expect(r.counterparty).toBe(`'=HYPERLINK("http://evil")`);
    expect(r.description).toBe("'+cmd");
    expect(r.reference).toBe("'-1+1");
    expect(svc.safeCell('Anna')).toBe('Anna');
    expect(svc.safeCell(null)).toBeNull();
  });

  test('the business export has no business column; the admin export does', async () => {
    prisma.transaction.findMany.mockResolvedValue([full()]);
    expect(Object.keys((await svc.exportRows({ businessId: 'biz1' }, {}))[0])).not.toContain('business');
    expect((await svc.exportRows({}, {}))[0].business).toBe('Acme');
  });

  test('refuses to build an unbounded file: more than the cap is a 422 asking to narrow the range', async () => {
    prisma.transaction.findMany.mockResolvedValue(new Array(svc.EXPORT_MAX_ROWS + 1).fill(full()));
    await expect(svc.exportRows({ businessId: 'biz1' }, {})).rejects.toMatchObject({ status: 422, message: expect.stringContaining('Narrow the date range') });
    expect(prisma.transaction.findMany.mock.calls[0][0].take).toBe(svc.EXPORT_MAX_ROWS + 1);
  });
});
