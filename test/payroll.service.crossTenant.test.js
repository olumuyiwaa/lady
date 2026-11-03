// getEarningsSummaryByCleanerId used to take only a cleanerId, with no
// businessId scoping on any of its four queries. It wasn't reachable with a
// client-supplied cleanerId in the code as it stood, but it's an exported
// function that a future admin-facing "view this cleaner's earnings" screen
// (see the payroll UI on the roadmap) would very plausibly call with a
// cleanerId straight from req.params — at which point it would leak
// whichever business that id happened to belong to.
//
// getMyEarningsSummary had a related, more subtle bug: without businessId
// in its own CleanerProfile lookup, a cleaner active in more than one
// business (now that switching businesses mid-session is supported) who
// called it without an explicit cleanerProfileId would fall back to
// whichever of their profiles was created first — possibly a different
// business than the one their session is currently scoped to.

jest.mock('../src/config/database.js', () => ({
  cleanerEarning: { aggregate: jest.fn(), findMany: jest.fn() },
  payout: { findMany: jest.fn() },
  cleanerProfile: { findFirst: jest.fn() },
}));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({}));

const prisma = require('../src/config/database.js');
const service = require('../src/modules/payroll/payroll.service');

const OWN_BUSINESS = 'biz-A';

beforeEach(() => {
  jest.clearAllMocks();
  prisma.cleanerEarning.aggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
  prisma.cleanerEarning.findMany.mockResolvedValue([]);
  prisma.payout.findMany.mockResolvedValue([]);
});

describe('getEarningsSummaryByCleanerId', () => {
  test('every query is scoped by businessId, not cleanerId alone', async () => {
    await service.getEarningsSummaryByCleanerId(OWN_BUSINESS, 'cl1');

    for (const call of prisma.cleanerEarning.aggregate.mock.calls) {
      expect(call[0].where).toMatchObject({ businessId: OWN_BUSINESS, cleanerId: 'cl1' });
    }
    expect(prisma.cleanerEarning.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: OWN_BUSINESS, cleanerId: 'cl1' } })
    );
    expect(prisma.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: OWN_BUSINESS, cleanerId: 'cl1' } })
    );
  });
});

describe('getMyEarningsSummary — multi-business cleaner', () => {
  test('the CleanerProfile lookup is scoped to the current business, so a cleaner active in two businesses gets the right one even without cleanerProfileId', async () => {
    prisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'profile-in-A' });

    await service.getMyEarningsSummary(OWN_BUSINESS, 'user1', undefined);

    expect(prisma.cleanerProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user1', businessId: OWN_BUSINESS, status: 'ACTIVE' }) })
    );
  });

  test('403s rather than falling back to a profile in a different business when none matches here', async () => {
    // Simulates: this user has an active cleaner profile, but not in
    // OWN_BUSINESS — the businessId-scoped query correctly finds nothing.
    prisma.cleanerProfile.findFirst.mockResolvedValue(null);

    await expect(service.getMyEarningsSummary(OWN_BUSINESS, 'user1', undefined)).rejects.toMatchObject({ status: 403 });
    expect(prisma.cleanerEarning.aggregate).not.toHaveBeenCalled();
  });

  test('resolved earnings are fetched for the business-scoped profile id, and businessId flows through to the underlying queries', async () => {
    prisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'profile-in-A' });

    await service.getMyEarningsSummary(OWN_BUSINESS, 'user1', 'profile-in-A');

    expect(prisma.cleanerEarning.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: OWN_BUSINESS, cleanerId: 'profile-in-A' } })
    );
  });
});
