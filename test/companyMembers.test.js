jest.mock('../src/config/database', () => ({
  customer: { findFirst: jest.fn(), findMany: jest.fn() },
  business: { findUnique: jest.fn() },
  booking: { findMany: jest.fn(), findFirst: jest.fn() },
  invoice: { findMany: jest.fn() },
  supportTicket: { findMany: jest.fn() },
  companyMember: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn() },
}));
const prisma = require('../src/config/database');
const scope = require('../src/lib/companyScope');
const members = require('../src/modules/b2b/members.service');
const b2bService = require('../src/modules/b2b/b2b.service');
const portal = require('../src/modules/customerPortal/customerPortal.service');
const { locationKey } = require('../src/lib/b2bAccount');

const A = { addressLine1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam' };
const B = { addressLine1: 'Keizersgracht 5', postalCode: '1015 CJ', city: 'Amsterdam' };
const bk = (id, addr, extra = {}) => ({ id, status: 'COMPLETED', scheduledStart: new Date('2026-10-05T08:00:00Z'), scheduledEnd: new Date('2026-10-05T10:00:00Z'), quotedPriceCents: 1000, ...addr, ...extra });
const manager = { memberId: 'm1', role: 'BRANCH_MANAGER', locationKeys: [locationKey(A)] };

beforeEach(() => {
  jest.resetAllMocks();
  prisma.business.findUnique.mockResolvedValue({ timezone: 'Europe/Amsterdam', currency: 'eur', name: 'Tod' });
  prisma.customer.findFirst.mockResolvedValue({ id: 'c', companyName: 'Acme BV' });
});

describe('companyScope', () => {
  test('no scope and ADMIN see everything; branch manager only their keys', () => {
    expect(scope.isRestricted(null)).toBe(false);
    expect(scope.isAdminScope(null)).toBe(true);
    const admin = scope.scopeOfMember({ id: 'a', role: 'ADMIN', locationKeys: ['x'] });
    expect(admin.locationKeys).toEqual([]);
    expect(scope.filterInScope(admin, [A, B])).toHaveLength(2);
    expect(scope.isAdminScope(manager)).toBe(false);
    expect(scope.filterInScope(manager, [A, B])).toEqual([A]);
  });
});

describe('members.service', () => {
  beforeEach(() => {
    prisma.booking.findMany.mockResolvedValue([bk('1', A), bk('2', B)]);
    prisma.companyMember.count.mockResolvedValue(0);
    prisma.companyMember.findFirst.mockResolvedValue(null);
    // The company itself is found by id; any email lookup (id: { not }) finds nobody.
    prisma.customer.findFirst.mockImplementation(async ({ where }) => (typeof where.id === 'string' ? { id: 'c', companyName: 'Acme BV' } : null));
    prisma.companyMember.create.mockImplementation(async ({ data }) => ({ id: 'm9', isActive: true, ...data }));
  });
  test('rejects non-business accounts', async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: 'c', companyName: null });
    await expect(members.list('b', 'c')).rejects.toMatchObject({ status: 403 });
  });
  test('branch manager needs at least one known location', async () => {
    const base = { firstName: 'Jo', email: 'jo@acme.nl', role: 'BRANCH_MANAGER' };
    await expect(members.create('b', 'c', { ...base, locationKeys: [] })).rejects.toMatchObject({ status: 422 });
    await expect(members.create('b', 'c', { ...base, locationKeys: ['nope'] })).rejects.toMatchObject({ status: 422 });
    const ok = await members.create('b', 'c', { ...base, locationKeys: [locationKey(A)] });
    expect(ok.locationKeys).toEqual([locationKey(A)]);
  });
  test('needs an email or phone, and ADMIN gets no locations', async () => {
    await expect(members.create('b', 'c', { firstName: 'Jo', role: 'ADMIN' })).rejects.toMatchObject({ status: 422 });
    const ok = await members.create('b', 'c', { firstName: 'Jo', email: 'JO@acme.nl', role: 'ADMIN', locationKeys: [locationKey(A)] });
    expect(ok.email).toBe('jo@acme.nl');
    expect(ok.locationKeys).toEqual([]);
  });
  test('login identifier already used by another customer is refused', async () => {
    prisma.customer.findFirst.mockImplementation(async ({ where }) => (typeof where.id === 'string' ? { id: 'c', companyName: 'Acme BV' } : { id: 'other' }));
    await expect(members.create('b', 'c', { firstName: 'Jo', email: 'jo@x.nl', role: 'ADMIN' })).rejects.toMatchObject({ status: 409 });
  });
  test('an admin cannot switch off or demote themselves', async () => {
    prisma.companyMember.findFirst.mockResolvedValue({ id: 'm1', role: 'ADMIN', email: 'a@x.nl', phone: null, locationKeys: [], isActive: true });
    await expect(members.deactivate('b', 'c', 'm1', { actorMemberId: 'm1' })).rejects.toMatchObject({ status: 422 });
    await expect(members.update('b', 'c', 'm1', { role: 'BRANCH_MANAGER', locationKeys: [locationKey(A)] }, { actorMemberId: 'm1' })).rejects.toMatchObject({ status: 422 });
  });
});

describe('scoped reporting', () => {
  test('quality report only counts the manager\'s branches', async () => {
    prisma.booking.findMany.mockResolvedValue([bk('1', A), bk('2', B)]);
    prisma.supportTicket.findMany.mockResolvedValue([]);
    const full = await b2bService.getQualityReport('b', 'c', '2026-10');
    const mine = await b2bService.getQualityReport('b', 'c', '2026-10', manager);
    expect(full.branches).toHaveLength(2);
    expect(mine.branches).toHaveLength(1);
    expect(mine.total.visits).toBe(1);
  });
  test('summary hides company-wide invoices from a branch manager', async () => {
    prisma.booking.findMany.mockResolvedValue([bk('1', A), bk('2', B)]);
    prisma.invoice.findMany.mockResolvedValue([{ grossCents: 500, dueAt: null, paidAt: null }]);
    const s = await b2bService.getSummary('b', 'c', '2026-10', manager);
    expect(s.invoices.openCount).toBe(0);
    expect(s.invoices.overdueCents).toBe(0);
  });
});

describe('portal scope guards', () => {
  test('booking outside the manager\'s branches is a 404, inside passes', async () => {
    prisma.booking.findFirst.mockResolvedValueOnce(B).mockResolvedValueOnce(A);
    await expect(portal.assertBookingInScope('b', 'c', 'x', manager)).rejects.toMatchObject({ status: 404 });
    await expect(portal.assertBookingInScope('b', 'c', 'y', manager)).resolves.toBeUndefined();
    await expect(portal.assertBookingInScope('b', 'c', 'z', null)).resolves.toBeUndefined();
  });
  test('booking list is filtered', async () => {
    prisma.booking.findMany.mockResolvedValue([{ id: '1', ...A }, { id: '2', ...B }]);
    const rows = await portal.listMyBookings('b', 'c', manager);
    expect(rows.map((r) => r.id)).toEqual(['1']);
  });
});
