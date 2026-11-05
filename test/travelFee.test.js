jest.mock('../src/config/database.js', () => ({
  businessPricing: { findUnique: jest.fn() },
  businessAddress: { findMany: jest.fn() },
  coupon: { findFirst: jest.fn() },
  giftCard: { findFirst: jest.fn() },
}));
jest.mock('../src/lib/distance', () => ({ distanceAndDuration: jest.fn() }));
jest.mock('../src/lib/geocode', () => ({ geocodeNl: jest.fn() }));

const prisma = require('../src/config/database.js');
const distance = require('../src/lib/distance');
const { geocodeNl } = require('../src/lib/geocode');
const { computeTravelFee, travelFeeFor, _clearDepotCache, ROAD_FACTOR } = require('../src/lib/travelFee');
const { calculateQuote } = require('../src/lib/pricing');
const { buildLines } = require('../src/modules/invoices/invoices.service');
const { splitGross } = require('../src/lib/vat');

// Amsterdam Centraal -> Utrecht Centraal is ~34.6 km in a straight line.
const AMSTERDAM = { latitude: 52.3791, longitude: 4.9003 };
const UTRECHT = { latitude: 52.0894, longitude: 5.1101 };
const service = { id: 's1', pricingModel: 'FLAT', basePriceCents: 10000, estimatedMinutes: 120, addOns: [] };

beforeEach(() => {
  jest.resetAllMocks();
  _clearDepotCache();
  distance.distanceAndDuration.mockResolvedValue(null); // no routing key: estimate
  prisma.businessAddress.findMany.mockResolvedValue([{ latitude: AMSTERDAM.latitude, longitude: AMSTERDAM.longitude, isPrimary: true }]);
});

describe('computeTravelFee', () => {
  const cfg = { freeKm: 10, perKmCents: 50, maxCents: 2000 };
  test('nothing inside the free radius', () => {
    expect(computeTravelFee({ distanceMeters: 8000, ...cfg }).cents).toBe(0);
    expect(computeTravelFee({ distanceMeters: 10000, ...cfg }).cents).toBe(0);
  });
  test('charges per km beyond the free radius', () => {
    const r = computeTravelFee({ distanceMeters: 20000, ...cfg });
    expect(r).toMatchObject({ cents: 500, distanceKm: 20, billableKm: 10 });
  });
  test('is capped by the maximum', () => {
    expect(computeTravelFee({ distanceMeters: 200000, ...cfg }).cents).toBe(2000);
  });
  test('rounds to whole 10-cent steps', () => {
    expect(computeTravelFee({ distanceMeters: 12345, freeKm: 0, perKmCents: 33 }).cents % 10).toBe(0);
  });
  test('is zero when switched off or the distance is unknown', () => {
    expect(computeTravelFee({ distanceMeters: 50000, freeKm: 0, perKmCents: null }).cents).toBe(0);
    expect(computeTravelFee({ distanceMeters: null, freeKm: 0, perKmCents: 50 }).cents).toBe(0);
  });
  test('a free radius of null means no free kilometres', () => {
    expect(computeTravelFee({ distanceMeters: 4000, perKmCents: 100 }).cents).toBe(400);
  });
});

describe('travelFeeFor', () => {
  const bp = { travelFreeKm: 10, travelFeePerKmCents: 50, travelFeeMaxCents: null };

  test('disabled businesses are never charged and never touch the database', async () => {
    const r = await travelFeeFor('b1', { travelFeePerKmCents: null }, UTRECHT);
    expect(r).toMatchObject({ enabled: false, cents: 0 });
    expect(prisma.businessAddress.findMany).not.toHaveBeenCalled();
  });
  test('estimates road distance as straight line x 1.3 without a routing key', async () => {
    const r = await travelFeeFor('b1', bp, UTRECHT);
    expect(r.source).toBe('estimate');
    expect(r.distanceMeters).toBeGreaterThan(34000 * ROAD_FACTOR * 0.97);
    expect(r.distanceMeters).toBeLessThan(36000 * ROAD_FACTOR * 1.03);
    expect(r.cents).toBeGreaterThan(0);
  });
  test('uses real driving distance when the routing service answers', async () => {
    distance.distanceAndDuration.mockResolvedValue({ distanceMeters: 30000, durationSeconds: 1900 });
    const r = await travelFeeFor('b1', bp, UTRECHT);
    expect(r).toMatchObject({ source: 'route', distanceMeters: 30000, cents: 1000 });
  });
  test('charges nothing when the customer address has no coordinates', async () => {
    expect(await travelFeeFor('b1', bp, {})).toMatchObject({ enabled: true, cents: 0 });
  });
  test('geocodes the base address once when it has no stored coordinates', async () => {
    prisma.businessAddress.findMany.mockResolvedValue([{ line1: 'Dam 1', city: 'Amsterdam', postalCode: '1012JS', latitude: null, longitude: null }]);
    geocodeNl.mockResolvedValue(AMSTERDAM);
    await travelFeeFor('b1', bp, UTRECHT);
    await travelFeeFor('b1', bp, UTRECHT);
    expect(geocodeNl).toHaveBeenCalledTimes(1);
  });
  test('a failure never blocks the quote: no fee', async () => {
    prisma.businessAddress.findMany.mockRejectedValue(new Error('db down'));
    expect(await travelFeeFor('b1', bp, UTRECHT)).toMatchObject({ cents: 0 });
  });
  test('no base address at all means no fee', async () => {
    prisma.businessAddress.findMany.mockResolvedValue([]);
    expect(await travelFeeFor('b1', bp, UTRECHT)).toMatchObject({ cents: 0 });
  });
});

describe('calculateQuote with a travel fee', () => {
  const bp = { frequencyDiscounts: null, travelFreeKm: 10, travelFeePerKmCents: 50, travelFeeMaxCents: null };

  test('adds the fee on top of the price and reports it in the breakdown', async () => {
    distance.distanceAndDuration.mockResolvedValue({ distanceMeters: 30000, durationSeconds: 1900 });
    prisma.businessPricing.findUnique.mockResolvedValue(bp);
    const q = await calculateQuote(service, { businessId: 'b1', ...UTRECHT });
    expect(q.priceCents).toBe(11000);
    expect(q.breakdown).toMatchObject({ base: 10000, travelFeeCents: 1000, travelDistanceMeters: 30000, total: 11000 });
    expect(q.travelFee).toMatchObject({ enabled: true, cents: 1000, freeKm: 10, perKmCents: 50 });
  });
  test('a percent coupon discounts the service but not the drive', async () => {
    distance.distanceAndDuration.mockResolvedValue({ distanceMeters: 30000, durationSeconds: 1900 });
    prisma.businessPricing.findUnique.mockResolvedValue(bp);
    prisma.coupon.findFirst.mockResolvedValue({ id: 'c1', type: 'PERCENT', value: 10, isActive: true });
    const q = await calculateQuote(service, { businessId: 'b1', couponCode: 'TEN', ...UTRECHT });
    expect(q.priceCents).toBe(9000 + 1000);
  });
  test('the frequency discount does not touch the travel fee either', async () => {
    distance.distanceAndDuration.mockResolvedValue({ distanceMeters: 30000, durationSeconds: 1900 });
    prisma.businessPricing.findUnique.mockResolvedValue({ ...bp, frequencyDiscounts: { WEEKLY: 0.1 } });
    const q = await calculateQuote(service, { businessId: 'b1', frequency: 'WEEKLY', ...UTRECHT });
    expect(q.priceCents).toBe(9000 + 1000);
  });
  test('a gift card is capped at the total including travel', async () => {
    distance.distanceAndDuration.mockResolvedValue({ distanceMeters: 30000, durationSeconds: 1900 });
    prisma.businessPricing.findUnique.mockResolvedValue(bp);
    prisma.giftCard.findFirst.mockResolvedValue({ id: 'g1', balanceCents: 50000, purchasePaidAt: new Date(), isActive: true });
    const q = await calculateQuote(service, { businessId: 'b1', giftCardCode: 'gc', ...UTRECHT });
    expect(q.giftCard.appliedCents).toBe(11000);
  });
  test('without coordinates or when disabled the price is unchanged', async () => {
    prisma.businessPricing.findUnique.mockResolvedValue(bp);
    expect((await calculateQuote(service, { businessId: 'b1' })).priceCents).toBe(10000);
    prisma.businessPricing.findUnique.mockResolvedValue({ ...bp, travelFeePerKmCents: null });
    const q = await calculateQuote(service, { businessId: 'b1', ...UTRECHT });
    expect(q.priceCents).toBe(10000);
    expect(q.travelFee).toBeUndefined();
    expect(q.breakdown.travelFeeCents).toBe(0);
  });
});

describe('invoice lines with travel', () => {
  const booking = (extra) => ({ service: { name: 'Home clean' }, addOns: [], quotedPriceCents: 11000, ...extra });
  const rate = 2100;

  test('without a travel fee there is one line, as before', () => {
    const lines = buildLines(booking(), rate, splitGross(11000, rate));
    expect(lines).toHaveLength(1);
    expect(lines[0].grossCents).toBe(11000);
  });
  test('travel is its own line and the lines add up to the invoice totals to the cent', () => {
    for (const [total, travel] of [[11000, 1000], [9999, 333], [12345, 1], [5000, 5000], [7777, 2599]]) {
      const totals = splitGross(total, rate);
      const lines = buildLines(booking({ quotedPriceCents: total, travelFeeCents: travel, travelDistanceMeters: 30000 }), rate, totals);
      const sum = (k) => lines.reduce((s, l) => s + l[k], 0);
      expect([sum('netCents'), sum('vatCents'), sum('grossCents')]).toEqual([totals.netCents, totals.vatCents, totals.grossCents]);
      expect(lines[1].grossCents).toBe(travel);
      expect(lines[1].description).toContain('30,0 km');
    }
  });
  test('a travel amount larger than the (manually reduced) price is clamped', () => {
    const lines = buildLines(booking({ quotedPriceCents: 3000, travelFeeCents: 9000 }), rate, splitGross(3000, rate));
    expect(lines.reduce((s, l) => s + l.grossCents, 0)).toBe(3000);
  });
});
