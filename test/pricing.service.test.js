/**
 * Covers the gap fixed here: PER_SQFT / PER_ROOM rates were hardcoded
 * module constants in lib/pricing.js, so every business on the platform
 * got the same 10c/sqft or $15/room rate regardless of their own market.
 * calculateQuote now reads BusinessPricing.perSqftCents/perRoomCents and
 * only falls back to the platform DEFAULTS when a business hasn't set
 * its own rate.
 */
jest.mock('../src/config/database.js', () => ({
  businessPricing: { findUnique: jest.fn() },
  coupon: { findFirst: jest.fn() },
}));

const mockPrisma = require('../src/config/database.js');
const { calculateQuote } = require('../src/lib/pricing');

describe('lib/pricing calculateQuote — per-business rates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const perSqftService = {
    id: 'svc1',
    pricingModel: 'PER_SQFT',
    basePriceCents: 0,
    estimatedMinutes: 60,
    addOns: [],
  };

  const perRoomService = {
    id: 'svc2',
    pricingModel: 'PER_ROOM',
    basePriceCents: 0,
    estimatedMinutes: 60,
    addOns: [],
  };

  test('uses the platform default per-sqft rate when the business has not set one', async () => {
    mockPrisma.businessPricing.findUnique.mockResolvedValue(null);
    const { priceCents } = await calculateQuote(perSqftService, { businessId: 'biz1', sqft: 1000 });
    // DEFAULTS.perSqftCents = 10
    expect(priceCents).toBe(1000 * 10);
  });

  test('uses the business-configured per-sqft rate instead of the default', async () => {
    mockPrisma.businessPricing.findUnique.mockResolvedValue({
      businessId: 'biz1',
      perSqftCents: 25,
      perRoomCents: null,
      frequencyDiscounts: null,
    });
    const { priceCents } = await calculateQuote(perSqftService, { businessId: 'biz1', sqft: 1000 });
    expect(priceCents).toBe(1000 * 25);
  });

  test('uses the business-configured per-room rate instead of the default', async () => {
    mockPrisma.businessPricing.findUnique.mockResolvedValue({
      businessId: 'biz2',
      perSqftCents: null,
      perRoomCents: 3000, // $30/room, vs. $15 default
      frequencyDiscounts: null,
    });
    const { priceCents } = await calculateQuote(perRoomService, { businessId: 'biz2', rooms: 4 });
    expect(priceCents).toBe(4 * 3000);
  });

  test('two businesses with different rates get different quotes for the same service inputs', async () => {
    mockPrisma.businessPricing.findUnique.mockResolvedValueOnce({
      businessId: 'lagos-biz',
      perSqftCents: 5,
      perRoomCents: null,
      frequencyDiscounts: null,
    });
    const lagos = await calculateQuote(perSqftService, { businessId: 'lagos-biz', sqft: 2000 });

    mockPrisma.businessPricing.findUnique.mockResolvedValueOnce({
      businessId: 'nyc-biz',
      perSqftCents: 40,
      perRoomCents: null,
      frequencyDiscounts: null,
    });
    const nyc = await calculateQuote(perSqftService, { businessId: 'nyc-biz', sqft: 2000 });

    expect(lagos.priceCents).toBe(2000 * 5);
    expect(nyc.priceCents).toBe(2000 * 40);
    expect(lagos.priceCents).not.toBe(nyc.priceCents);
  });

  test('a businessPricing row with only frequencyDiscounts set still falls back to default rates', async () => {
    mockPrisma.businessPricing.findUnique.mockResolvedValue({
      businessId: 'biz3',
      perSqftCents: null,
      perRoomCents: null,
      frequencyDiscounts: { WEEKLY: 0.2 },
    });
    const { priceCents, breakdown } = await calculateQuote(perSqftService, {
      businessId: 'biz3',
      sqft: 100,
      frequency: 'WEEKLY',
    });
    // base = 100 * 10 (default) = 1000, then 20% off = 800
    expect(breakdown.base).toBe(1000);
    expect(priceCents).toBe(800);
  });
});
