jest.mock('../src/config/database', () => ({ companyMember: { findFirst: jest.fn() } }));
jest.mock('../src/utils/jwt', () => ({ verifyAccessToken: jest.fn() }));
const prisma = require('../src/config/database');
const { verifyAccessToken } = require('../src/utils/jwt');
const { requireCustomerPortal, requirePortalAdmin } = require('../src/modules/customerPortal/customerPortal.middleware');

const run = async (mw, req) => new Promise((resolve) => mw(req, {}, (err) => resolve(err || null)));
const req = () => ({ headers: { authorization: 'Bearer t' }, businessId: 'b' });
const payload = { scope: 'CUSTOMER_PORTAL', aud: 'customer-portal', sub: 'u', portalCustomerId: 'c' };

beforeEach(() => jest.resetAllMocks());

test('account holder token has no scope', async () => {
  verifyAccessToken.mockReturnValue(payload);
  const r = req();
  expect(await run(requireCustomerPortal, r)).toBeNull();
  expect(r.portalScope).toBeNull();
  expect(await run(requirePortalAdmin, r)).toBeNull();
});

test('member token loads the live scope; branch manager is not admin', async () => {
  verifyAccessToken.mockReturnValue({ ...payload, portalMemberId: 'm1' });
  prisma.companyMember.findFirst.mockResolvedValue({ id: 'm1', role: 'BRANCH_MANAGER', locationKeys: ['k'] });
  const r = req();
  expect(await run(requireCustomerPortal, r)).toBeNull();
  expect(r.portalScope).toEqual({ memberId: 'm1', role: 'BRANCH_MANAGER', locationKeys: ['k'] });
  expect(await run(requirePortalAdmin, r)).toMatchObject({ status: 403 });
});

test('deactivated member is rejected at once', async () => {
  verifyAccessToken.mockReturnValue({ ...payload, portalMemberId: 'm1' });
  prisma.companyMember.findFirst.mockResolvedValue(null);
  expect(await run(requireCustomerPortal, req())).toMatchObject({ status: 401 });
});
