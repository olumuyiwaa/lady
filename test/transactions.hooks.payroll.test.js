/** A cleaner payout reaches the log once it is actually PAID, by either route. */
jest.mock('../src/config/database.js', () => ({
  payout: { findFirst: jest.fn(), update: jest.fn() },
  cleanerEarning: { updateMany: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({ payCleanerTransfer: jest.fn() }));
jest.mock('../src/modules/transactions/transactions.service', () => ({ record: jest.fn() }));

const prisma = require('../src/config/database.js');
const { payCleanerTransfer } = require('../src/lib/stripeClient');
const transactions = require('../src/modules/transactions/transactions.service');
const payroll = require('../src/modules/payroll/payroll.service');

const base = {
  id: 'po1', businessId: 'biz1', cleanerId: 'cl1', status: 'PENDING', totalCents: 15000,
  business: { id: 'biz1', currency: 'eur', stripeConnectedAccountId: 'acct_b' },
  cleaner: { id: 'cl1', user: { firstName: 'Ada', lastName: 'Okafor', stripeConnectedAccountId: 'acct_c' } },
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ENABLE_STRIPE_CLEANER_PAYOUTS = 'true';
  transactions.record.mockResolvedValue(true);
  prisma.$transaction.mockImplementation(async (fn) => fn({ payout: { update: prisma.payout.update }, cleanerEarning: { updateMany: prisma.cleanerEarning.updateMany } }));
  prisma.payout.update.mockImplementation(({ data }) => ({ ...base, ...data, paidAt: new Date('2026-05-01') }));
});

test('a Stripe payout is logged OUT with the cleaner name, business currency and transfer id', async () => {
  prisma.payout.findFirst.mockResolvedValue(base);
  payCleanerTransfer.mockResolvedValue({ id: 'tr_1' });
  await payroll.payViaStripe('biz1', 'u1', 'po1');
  expect(transactions.record.mock.calls[0][0]).toMatchObject({
    type: 'CLEANER_PAYOUT', direction: 'OUT', method: 'STRIPE', amountCents: 15000, currency: 'EUR', counterpartyName: 'Ada Okafor',
    payoutId: 'po1', cleanerId: 'cl1', stripeTransferId: 'tr_1', dedupeKey: 'payout:po1',
  });
});

test('a payout marked paid by hand is logged with its method and reference', async () => {
  prisma.payout.findFirst.mockResolvedValue(base);
  prisma.payout.update.mockImplementation(({ data }) => ({ ...base, ...data, paidAt: new Date('2026-05-01') }));
  await payroll.markPayoutPaid('biz1', 'u1', 'po1', { method: 'MANUAL_TRANSFER', reference: 'REF-9' });
  expect(transactions.record.mock.calls[0][0]).toMatchObject({ type: 'CLEANER_PAYOUT', direction: 'OUT', method: 'BANK_TRANSFER', reference: 'REF-9', amountCents: 15000, dedupeKey: 'payout:po1' });
});

test('a Stripe transfer that fails is not logged as paid', async () => {
  prisma.payout.findFirst.mockResolvedValue(base);
  payCleanerTransfer.mockRejectedValue(new Error('insufficient funds'));
  await payroll.payViaStripe('biz1', 'u1', 'po1').catch(() => {});
  expect(transactions.record).not.toHaveBeenCalled();
});
