/**
 * NOTE ON MOCKING STYLE: the existing test/auth.service.test.js mocks
 * src/config/database.js by pre-seeding require.cache before requiring the
 * service under test. That doesn't actually work under Jest — Jest's
 * module registry is separate from Node's native require.cache, so the
 * real database.js (and the real @prisma/client) still gets executed. In
 * an environment without a generated Prisma client this fails outright
 * ("@prisma/client did not initialize yet"); in one *with* a generated
 * client it would silently run against the real, unmocked module, meaning
 * that test suite has never actually exercised the mocked behavior it
 * asserts on. jest.mock() is the technique that actually intercepts the
 * module — use that pattern for new tests instead of the require.cache one.
 */
jest.mock('../src/config/database.js', () => ({
  businessPricing: { findUnique: jest.fn() },
}));

const mockPrisma = require('../src/config/database.js');
const { evaluateCancellation } = require('../src/lib/cancellationPolicy');

describe('cancellationPolicy.evaluateCancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseBooking = {
    quotedPriceCents: 10000, // $100
    paymentStatus: 'PAID',
    amountPaidCents: 10000,
    depositRequiredCents: null,
    depositPaidAt: null,
    stripePaymentIntentId: 'pi_job_123',
    stripeDepositPaymentIntentId: null,
  };

  test('no policy configured => always free, full refund available', async () => {
    mockPrisma.businessPricing.findUnique.mockResolvedValue(null);
    const booking = { ...baseBooking, scheduledStart: new Date(Date.now() + 3600 * 1000) }; // 1h out
    const result = await evaluateCancellation('biz1', booking);
    expect(result.withinFreeWindow).toBe(true);
    expect(result.feeCents).toBe(0);
    expect(result.refundCents).toBe(10000);
  });

  test('outside the cancellation window => free, full refund', async () => {
    mockPrisma.businessPricing.findUnique.mockResolvedValue({
      cancellationWindowHours: 24,
      cancellationFeeType: 'PERCENT',
      cancellationFeeValue: 50,
    });
    const booking = { ...baseBooking, scheduledStart: new Date(Date.now() + 48 * 3600 * 1000) }; // 48h out
    const result = await evaluateCancellation('biz1', booking);
    expect(result.withinFreeWindow).toBe(true);
    expect(result.feeCents).toBe(0);
    expect(result.refundCents).toBe(10000);
  });

  test('inside the window with a PERCENT fee => fee deducted from refund', async () => {
    mockPrisma.businessPricing.findUnique.mockResolvedValue({
      cancellationWindowHours: 24,
      cancellationFeeType: 'PERCENT',
      cancellationFeeValue: 50, // 50%
    });
    const booking = { ...baseBooking, scheduledStart: new Date(Date.now() + 3600 * 1000) }; // 1h out
    const result = await evaluateCancellation('biz1', booking);
    expect(result.withinFreeWindow).toBe(false);
    expect(result.feeCents).toBe(5000);
    expect(result.refundCents).toBe(5000);
    expect(result.refundPaymentIntentId).toBe('pi_job_123');
  });

  test('inside the window with a flat AMOUNT fee, capped at what was actually paid', async () => {
    mockPrisma.businessPricing.findUnique.mockResolvedValue({
      cancellationWindowHours: 24,
      cancellationFeeType: 'AMOUNT',
      cancellationFeeValue: 999999, // deliberately far above what was paid
    });
    const booking = { ...baseBooking, amountPaidCents: 3000, quotedPriceCents: 10000, scheduledStart: new Date(Date.now() + 3600 * 1000) };
    const result = await evaluateCancellation('biz1', booking);
    expect(result.feeCents).toBe(3000); // capped at alreadyPaidCents
    expect(result.refundCents).toBe(0);
  });

  test('only a deposit was paid (job unpaid) => refunds against the deposit intent', async () => {
    mockPrisma.businessPricing.findUnique.mockResolvedValue({
      cancellationWindowHours: 24,
      cancellationFeeType: 'PERCENT',
      cancellationFeeValue: 100,
    });
    const booking = {
      ...baseBooking,
      paymentStatus: 'UNPAID',
      amountPaidCents: null,
      depositRequiredCents: 2000,
      depositPaidAt: new Date(),
      stripePaymentIntentId: null,
      stripeDepositPaymentIntentId: 'pi_deposit_456',
      scheduledStart: new Date(Date.now() + 3600 * 1000),
    };
    const result = await evaluateCancellation('biz1', booking);
    expect(result.alreadyPaidCents).toBe(2000);
    expect(result.feeCents).toBe(2000);
    expect(result.refundPaymentIntentId).toBe('pi_deposit_456');
  });
});
