/**
 * Covers the gap fixed here: Payout used to only ever be settled manually
 * (business ticks "mark as paid" once money moved outside Tod Cleaning Services).
 * payViaStripe adds a real disbursement path: a Stripe transfer from the
 * business's own Connect balance to the cleaner's connected account.
 */
jest.mock('../src/config/database.js', () => ({
  payout: { findFirst: jest.fn(), update: jest.fn() },
  cleanerEarning: { updateMany: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({
  payCleanerTransfer: jest.fn(),
}));

const mockPrisma = require('../src/config/database.js');
const { audit } = require('../src/utils/audit');
const { payCleanerTransfer } = require('../src/lib/stripeClient');
const payrollService = require('../src/modules/payroll/payroll.service');

describe('payroll.service.payViaStripe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_STRIPE_CLEANER_PAYOUTS = 'true';
    // Mirrors how the real prisma client resolves $transaction: run the
    // callback against a tx object whose methods we can assert on.
    mockPrisma.$transaction.mockImplementation(async (fn) =>
      fn({
        payout: { update: mockPrisma.payout.update },
        cleanerEarning: { updateMany: mockPrisma.cleanerEarning.updateMany },
      })
    );
  });

  const basePayout = {
    id: 'payout1',
    businessId: 'biz1',
    status: 'PENDING',
    totalCents: 15000,
    business: { id: 'biz1', stripeConnectedAccountId: 'acct_business_1' },
    cleaner: {
      id: 'cleaner1',
      user: {
        id: 'user1',
        firstName: 'Ada',
        lastName: 'Okafor',
        stripeConnectedAccountId: 'acct_cleaner_1',
      },
    },
  };

  test('transfers funds from the business Connect balance to the cleaner and marks the payout PAID', async () => {
    mockPrisma.payout.findFirst.mockResolvedValue(basePayout);
    payCleanerTransfer.mockResolvedValue({ id: 'tr_123' });
    mockPrisma.payout.update.mockImplementation(({ data }) => ({ ...basePayout, ...data }));

    const result = await payrollService.payViaStripe('biz1', 'actorUser1', 'payout1');

    expect(payCleanerTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        businessConnectedAccountId: 'acct_business_1',
        cleanerConnectedAccountId: 'acct_cleaner_1',
        amountCents: 15000,
        payoutId: 'payout1',
      })
    );
    expect(mockPrisma.payout.update).toHaveBeenCalledWith({
      where: { id: 'payout1' },
      data: { status: 'PAID', paidAt: expect.any(Date), method: 'STRIPE', stripeTransferId: 'tr_123' },
    });
    expect(mockPrisma.cleanerEarning.updateMany).toHaveBeenCalledWith({
      where: { payoutId: 'payout1' },
      data: { status: 'PAID' },
    });
    expect(result.status).toBe('PAID');
    expect(result.stripeTransferId).toBe('tr_123');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYOUT_PAID_VIA_STRIPE' }));
  });

  test('is idempotent — a payout that is already PAID is returned as-is without a second transfer', async () => {
    mockPrisma.payout.findFirst.mockResolvedValue({ ...basePayout, status: 'PAID' });

    const result = await payrollService.payViaStripe('biz1', 'actorUser1', 'payout1');

    expect(payCleanerTransfer).not.toHaveBeenCalled();
    expect(result.status).toBe('PAID');
  });

  test('rejects paying a canceled payout', async () => {
    mockPrisma.payout.findFirst.mockResolvedValue({ ...basePayout, status: 'CANCELED' });

    await expect(payrollService.payViaStripe('biz1', 'actorUser1', 'payout1')).rejects.toThrow(
      /Cannot pay a canceled payout/
    );
    expect(payCleanerTransfer).not.toHaveBeenCalled();
  });

  test('404s when the payout does not belong to this business', async () => {
    mockPrisma.payout.findFirst.mockResolvedValue(null);

    await expect(payrollService.payViaStripe('biz1', 'actorUser1', 'nope')).rejects.toThrow(
      /Payout not found/
    );
  });

  test('surfaces a 402 when the cleaner has not connected a payout account', async () => {
    mockPrisma.payout.findFirst.mockResolvedValue({
      ...basePayout,
      cleaner: { ...basePayout.cleaner, user: { ...basePayout.cleaner.user, stripeConnectedAccountId: null } },
    });
    const err = new Error('Cleaner has not completed Stripe Connect onboarding');
    err.status = 402;
    payCleanerTransfer.mockRejectedValue(err);

    await expect(payrollService.payViaStripe('biz1', 'actorUser1', 'payout1')).rejects.toMatchObject({
      status: 402,
    });
    expect(mockPrisma.payout.update).not.toHaveBeenCalled();
  });

  test('is refused (501) unless ENABLE_STRIPE_CLEANER_PAYOUTS is on', async () => {
    delete process.env.ENABLE_STRIPE_CLEANER_PAYOUTS;
    await expect(payrollService.payViaStripe('biz1', 'user1', 'po1')).rejects.toMatchObject({ status: 501 });
    expect(mockPrisma.payout.findFirst).not.toHaveBeenCalled();
    expect(payCleanerTransfer).not.toHaveBeenCalled();
  });
});
