jest.mock('../src/config/database.js', () => ({
  user: { findUnique: jest.fn() },
  businessMember: { findFirst: jest.fn() },
  cleanerProfile: { findFirst: jest.fn() },
  business: { findUnique: jest.fn(), update: jest.fn() },
}));
jest.mock('../src/config/storage', () => ({ getPublicUploadUrl: jest.fn(), getPublicUrl: jest.fn() }));
jest.mock('../src/lib/subscriptionAccess', () => ({ getEffectivePlan: jest.fn(), getAccess: jest.fn() }));

process.env.JWT_SECRET = 'test-secret';
const jwt = require('jsonwebtoken');
const prisma = require('../src/config/database.js');
const { authenticate, requireRole } = require('../src/middleware/authenticate');
const { isValidTimeZone } = require('../src/utils/timezone');
const businesses = require('../src/modules/businesses/businesses.service');

const mkRes = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
const reqFor = (payload) => ({ headers: { authorization: `Bearer ${jwt.sign({ sub: 'u1', ...payload }, 'test-secret')}` } });

beforeEach(() => { jest.resetAllMocks(); prisma.user.findUnique.mockResolvedValue({ id: 'u1', isActive: true, globalRole: 'USER' }); });

describe('suspended businesses are locked out', () => {
  test('staff of a deactivated business get 403 BUSINESS_SUSPENDED on every authenticated request', async () => {
    prisma.businessMember.findFirst.mockResolvedValue({ businessId: 'b1', role: 'BUSINESS_OWNER', business: { isActive: false } });
    const res = mkRes(); const next = jest.fn();
    await authenticate(reqFor({ businessId: 'b1' }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].errors.code).toBe('BUSINESS_SUSPENDED');
    expect(next).not.toHaveBeenCalled();
  });
  test('so do its cleaners', async () => {
    prisma.businessMember.findFirst.mockResolvedValue(null);
    prisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'cl1', businessId: 'b1', business: { isActive: false } });
    const res = mkRes();
    await authenticate(reqFor({ businessId: 'b1' }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });
  test('an active business is unaffected', async () => {
    prisma.businessMember.findFirst.mockResolvedValue({ businessId: 'b1', role: 'BUSINESS_OWNER', business: { isActive: true } });
    const req = reqFor({ businessId: 'b1' }); const next = jest.fn();
    await authenticate(req, mkRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ businessId: 'b1', businessRole: 'BUSINESS_OWNER' });
  });
});

describe('cleaners cannot read business-wide data', () => {
  test('requireRole(owner, manager) rejects a CLEANER and accepts staff', () => {
    const guard = requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER');
    const res = mkRes(); const next = jest.fn();
    guard({ user: { businessRole: 'CLEANER' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    guard({ user: { businessRole: 'BUSINESS_MANAGER' } }, mkRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
  test.each([
    ['customers', ['/', '/:id']],
    ['reviews', ['/', '/:id']],
    ['storage', ['/']],
    ['reports', ['/', '/kpis']],
    ['calendar', ['/events']],
  ])('%s: GET routes are role-guarded', (mod, paths) => {
    const router = require(`../src/modules/${mod}/${mod}.routes`);
    for (const path of paths) {
      const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
      expect(layer).toBeDefined();
      // authenticate+scope are router.use; the route itself must carry requireRole + handler (>= 2 handlers)
      expect(layer.route.stack.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('timezone validation', () => {
  test('isValidTimeZone', () => {
    expect(isValidTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    for (const bad of ['Mars/Olympus', '', null, undefined, 'Europe/Amsterdam; DROP', 42]) expect(isValidTimeZone(bad)).toBe(false);
  });
  test('updateBusiness rejects an invalid zone before touching the row', async () => {
    prisma.business.findUnique.mockResolvedValue({ id: 'b1', currency: 'eur', timezone: 'Europe/Amsterdam' });
    await expect(businesses.updateBusiness('b1', { timezone: 'Mars/Olympus' })).rejects.toMatchObject({ status: 422 });
    expect(prisma.business.update).not.toHaveBeenCalled();
    prisma.business.update.mockResolvedValue({});
    await businesses.updateBusiness('b1', { timezone: 'Europe/Brussels' });
    expect(prisma.business.update).toHaveBeenCalled();
  });
});
