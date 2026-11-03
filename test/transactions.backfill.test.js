const { backfill } = require('../scripts/backfillTransactions');

const date = (d) => new Date(`2026-${d}T10:00:00Z`);
const bookingRow = (i, over = {}) => ({
  id: `bk${String(i).padStart(4, '0')}`, businessId: 'biz1', customerId: 'c1', customer: { firstName: 'Anna', lastName: 'de Vries' },
  business: { currency: 'eur' }, invoice: null, quotedPriceCents: 10000, giftCardAppliedCents: null,
  depositRequiredCents: 2000, depositPaidAt: date('01-02'), stripeDepositPaymentIntentId: 'pi_d',
  amountPaidCents: 8000, paymentStatus: 'PAID', stripePaymentIntentId: 'pi_j',
  tipAmountCents: null, tipPaidAt: null, refundedAmountCents: null, refundedAt: null, stripeRefundId: null,
  createdAt: date('01-01'), updatedAt: date('01-05'), ...over,
});

function fakePrisma({ bookings = [], payouts = [], invoices = [] } = {}) {
  const pager = (all) => jest.fn(async ({ take, skip, cursor }) => {
    const start = cursor ? all.findIndex((r) => r.id === cursor.id) + (skip || 0) : 0;
    return all.slice(start, start + take);
  });
  return {
    booking: { findMany: pager(bookings) },
    payout: { findMany: pager(payouts) },
    platformInvoice: { findMany: pager(invoices) },
    transaction: { createMany: jest.fn(async ({ data }) => ({ count: data.length })) },
  };
}
const quiet = { log: jest.fn() };
const inserted = (prisma) => prisma.transaction.createMany.mock.calls.flatMap(([a]) => a.data);

test('rebuilds deposit and job payment per booking, flagged as backfilled', async () => {
  const prisma = fakePrisma({ bookings: [bookingRow(1)] });
  const tally = await backfill({ prisma, ...quiet });
  const rows = inserted(prisma);
  expect(rows.map((r) => r.type).sort()).toEqual(['BOOKING_PAYMENT', 'DEPOSIT']);
  expect(rows.every((r) => r.backfilled === true && r.currency === 'EUR' && r.counterpartyName === 'Anna de Vries')).toBe(true);
  expect(tally.bookings).toEqual({ found: 2, inserted: 2 });
});

test('inserts with skipDuplicates, which is what makes a second run (or a run during live traffic) harmless', async () => {
  const prisma = fakePrisma({ bookings: [bookingRow(1)] });
  await backfill({ prisma, ...quiet });
  expect(prisma.transaction.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
});

test('a dry run counts but writes nothing', async () => {
  const prisma = fakePrisma({ bookings: [bookingRow(1)], payouts: [{ id: 'po1', businessId: 'biz1', cleanerId: 'c', totalCents: 5000, method: 'STRIPE', paidAt: date('02-01'), business: { currency: 'eur' }, cleaner: { user: { firstName: 'Ada', lastName: 'O' } } }] });
  const tally = await backfill({ prisma, dryRun: true, ...quiet });
  expect(prisma.transaction.createMany).not.toHaveBeenCalled();
  expect(tally.bookings.found).toBe(2);
  expect(tally.payouts.found).toBe(1);
  expect(tally.bookings.inserted).toBe(0);
});

test('walks tables larger than one batch without skipping or repeating a row', async () => {
  const bookings = Array.from({ length: 1203 }, (_, i) => bookingRow(i, { depositPaidAt: null, depositRequiredCents: null, amountPaidCents: 5000 }));
  const prisma = fakePrisma({ bookings });
  await backfill({ prisma, ...quiet });
  const ids = inserted(prisma).map((r) => r.bookingId);
  expect(ids).toHaveLength(1203);
  expect(new Set(ids).size).toBe(1203);
  expect(prisma.booking.findMany.mock.calls.length).toBe(3); // 500 + 500 + 203
  expect(prisma.booking.findMany.mock.calls[1][0].cursor).toEqual({ id: 'bk0499' });
});

test('uses the invoice paid date for the job payment when there is one', async () => {
  const prisma = fakePrisma({ bookings: [bookingRow(1, { depositPaidAt: null, depositRequiredCents: null, invoice: { paidAt: date('01-09') } })] });
  await backfill({ prisma, ...quiet });
  expect(inserted(prisma)[0].occurredAt).toEqual(date('01-09'));
});

test('only PAID payouts become rows, with the cleaner name and the business currency', async () => {
  const payout = { id: 'po1', businessId: 'biz1', cleanerId: 'cl1', totalCents: 9000, method: 'MANUAL_CASH', paidAt: date('02-01'), business: { currency: 'gbp' }, cleaner: { user: { firstName: 'Ada', lastName: 'Okafor' } } };
  const prisma = fakePrisma({ payouts: [payout] });
  await backfill({ prisma, ...quiet });
  expect(prisma.payout.findMany.mock.calls[0][0].where).toEqual({ status: 'PAID', paidAt: { not: null } });
  expect(inserted(prisma)[0]).toMatchObject({ type: 'CLEANER_PAYOUT', method: 'CASH', currency: 'GBP', counterpartyName: 'Ada Okafor', backfilled: true });
});

test('subscription invoices: paid and failed-open are kept; void, uncollectible and free (0) invoices are not', async () => {
  const inv = (id, status, amountCents) => ({ id, stripeInvoiceId: `in_${id}`, amountCents, status, issuedAt: date('03-01'), paidAt: status === 'paid' ? date('03-02') : null, subscription: { businessId: 'biz1', business: { currency: 'eur' } } });
  const prisma = fakePrisma({ invoices: [inv('1', 'paid', 2900), inv('2', 'open', 2900), inv('3', 'void', 2900), inv('4', 'uncollectible', 2900), inv('5', 'paid', 0)] });
  await backfill({ prisma, ...quiet });
  const rows = inserted(prisma);
  expect(rows.map((r) => [r.stripeInvoiceId, r.status])).toEqual([['in_1', 'SUCCEEDED'], ['in_2', 'FAILED']]);
});

test('an unpaid booking with nothing to record produces no insert at all', async () => {
  const prisma = fakePrisma({ bookings: [bookingRow(1, { depositPaidAt: null, depositRequiredCents: null, amountPaidCents: null, paymentStatus: 'UNPAID' })] });
  await backfill({ prisma, ...quiet });
  expect(prisma.transaction.createMany).not.toHaveBeenCalled();
});

test('a booking the earlier query would select but that holds no cash (e.g. fully paid by gift card) records nothing', async () => {
  const prisma = fakePrisma({ bookings: [bookingRow(1, { depositPaidAt: null, depositRequiredCents: null, amountPaidCents: null, paymentStatus: 'PAID', quotedPriceCents: 5000, giftCardAppliedCents: 5000 })] });
  await backfill({ prisma, ...quiet });
  expect(prisma.transaction.createMany).not.toHaveBeenCalled();
});
