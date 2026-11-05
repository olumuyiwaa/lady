jest.mock('../src/config/database', () => ({
  review: { groupBy: jest.fn(), findMany: jest.fn() },
  bookingAssignment: { groupBy: jest.fn() },
}));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const prisma = require('../src/config/database');
const { scoreCandidate, rankCandidates, smoothedRating } = require('../src/lib/matchScore');

beforeEach(() => {
  jest.clearAllMocks();
  prisma.review.groupBy.mockResolvedValue([]);
  prisma.review.findMany.mockResolvedValue([]);
  prisma.bookingAssignment.groupBy.mockResolvedValue([]);
});

describe('scoreCandidate', () => {
  test('closer, better rated, known and idle cleaners score higher', () => {
    const strong = scoreCandidate({ distanceMeters: 2000, workload: 0 }, { ratingSum: 49, ratingCount: 10, visits: 3 });
    const weak = scoreCandidate({ distanceMeters: 25000, workload: 4 }, { ratingSum: 30, ratingCount: 10, visits: 0 });
    expect(strong.score).toBeGreaterThan(weak.score);
    expect(strong.score).toBeLessThanOrEqual(100);
    expect(strong.reasons.map((r) => r.key)).toEqual(expect.arrayContaining(['CLOSE', 'TOP_RATED', 'KNOWS_CUSTOMER', 'FREE_DAY']));
    expect(weak.reasons.map((r) => r.key)).toContain('LOW_RATING');
  });

  test('a single 5-star review does not beat a long record of 4.8', () => {
    expect(smoothedRating(5, 1)).toBeLessThan(smoothedRating(240, 50));
  });

  test('a low rating from this customer is a penalty', () => {
    const base = scoreCandidate({ distanceMeters: 3000, workload: 1 }, { visits: 1 });
    const bad = scoreCandidate({ distanceMeters: 3000, workload: 1 }, { visits: 1, customerRating: 1 });
    expect(bad.score).toBeLessThan(base.score);
    expect(bad.reasons.map((r) => r.key)).toContain('CUSTOMER_LOW_RATED');
  });

  test('unknown distance is neutral, preference adds points and a reason', () => {
    const a = scoreCandidate({ distanceMeters: null, workload: 0 }, {});
    const b = scoreCandidate({ distanceMeters: null, workload: 0 }, { preferred: true });
    expect(b.score).toBeGreaterThan(a.score);
    expect(b.reasons.map((r) => r.key)).toContain('PREFERRED');
  });
});

describe('rankCandidates', () => {
  const mk = (id, distanceMeters, workload = 0) => ({ cleaner: { id }, distanceMeters, workload });

  test('orders by score using ratings and history', async () => {
    prisma.review.groupBy.mockResolvedValue([
      { cleanerId: 'a', _avg: { rating: 3 }, _count: { rating: 10 } },
      { cleanerId: 'b', _avg: { rating: 4.9 }, _count: { rating: 10 } },
    ]);
    const out = await rankCandidates('biz', 'cust', [mk('a', 3000), mk('b', 4000)]);
    expect(out.map((c) => c.cleaner.id)).toEqual(['b', 'a']);
    expect(out[0].matchScore).toBeGreaterThan(out[1].matchScore);
  });

  test('preferred cleaner stays first even with a lower score', async () => {
    prisma.review.groupBy.mockResolvedValue([{ cleanerId: 'a', _avg: { rating: 2 }, _count: { rating: 10 } }]);
    const out = await rankCandidates('biz', 'cust', [mk('b', 1000), mk('a', 20000, 3)], { preferredId: 'a' });
    expect(out[0].cleaner.id).toBe('a');
  });

  test('lookup failures fall back to neutral scores instead of throwing', async () => {
    prisma.review.groupBy.mockRejectedValue(new Error('db down'));
    prisma.bookingAssignment.groupBy.mockRejectedValue(new Error('db down'));
    const out = await rankCandidates('biz', 'cust', [mk('a', 1000), mk('b', 9000)]);
    expect(out).toHaveLength(2);
    expect(out[0].cleaner.id).toBe('a');
  });

  test('ties keep scheduler order', async () => {
    const out = await rankCandidates('biz', null, [mk('x', 5000), mk('y', 5000)]);
    expect(out.map((c) => c.cleaner.id)).toEqual(['x', 'y']);
  });
});
