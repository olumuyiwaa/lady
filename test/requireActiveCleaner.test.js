jest.mock('../src/config/database.js', () => ({ cleanerProfile: { findFirst: jest.fn() } }));
const prisma = require('../src/config/database.js');
const { requireActiveCleaner } = require('../src/middleware/requireActiveCleaner');

const mkRes = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
beforeEach(() => jest.clearAllMocks());

test('uses the workspace chosen at login for a cleaner with two businesses', async () => {
  prisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'clB', businessId: 'bizB' });
  const req = { user: { id: 'u1', cleanerProfileId: 'clB' } };
  const next = jest.fn();
  await requireActiveCleaner(req, mkRes(), next);
  expect(prisma.cleanerProfile.findFirst.mock.calls[0][0].where).toEqual({ userId: 'u1', status: 'ACTIVE', id: 'clB' });
  expect(req.businessId).toBe('bizB');
  expect(next).toHaveBeenCalled();
});

test('falls back to the first active profile when the token carries no workspace', async () => {
  prisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'clA', businessId: 'bizA' });
  await requireActiveCleaner({ user: { id: 'u1' } }, mkRes(), jest.fn());
  expect(prisma.cleanerProfile.findFirst.mock.calls[0][0].where).toEqual({ userId: 'u1', status: 'ACTIVE' });
});

test('403 when there is no active profile (e.g. after offboarding)', async () => {
  prisma.cleanerProfile.findFirst.mockResolvedValue(null);
  const res = mkRes();
  await requireActiveCleaner({ user: { id: 'u1' } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(403);
});
