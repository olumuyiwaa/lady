jest.mock('../src/config/database.js', () => ({
  calendarFeed: { count: jest.fn(), create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  cleanerProfile: { findFirst: jest.fn() },
  businessMember: { findFirst: jest.fn() },
  booking: { findMany: jest.fn() },
}));
const prisma = require('../src/config/database.js');
const service = require('../src/modules/calendar/calendarFeed.service');

const owner = { id: 'u-owner', businessRole: 'BUSINESS_OWNER' };
const cleaner = { id: 'u-cl', businessRole: 'CLEANER', cleanerProfileId: 'cp1' };
const base = 'https://api.example.com/';

beforeEach(() => {
  jest.resetAllMocks();
  prisma.calendarFeed.count.mockResolvedValue(0);
  prisma.calendarFeed.create.mockImplementation(async ({ data }) => ({ id: 'f1', createdAt: new Date(), ...data }));
  prisma.calendarFeed.update.mockResolvedValue({});
  prisma.booking.findMany.mockResolvedValue([]);
});

describe('createFeed', () => {
  test('returns the secret URL once and stores only its hash', async () => {
    const out = await service.createFeed({ businessId: 'b1', actor: owner, baseUrl: base });
    const token = out.url.split('/calendar-feed/')[1].replace('.ics', '');
    expect(out.url.startsWith('https://api.example.com/api/v1/calendar-feed/')).toBe(true);
    expect(out.webcalUrl.startsWith('webcal://')).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(43);
    const stored = prisma.calendarFeed.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(service.hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  test('a cleaner always gets a feed of their OWN jobs, whatever they ask for', async () => {
    await service.createFeed({ businessId: 'b1', actor: cleaner, cleanerId: 'someone-else', baseUrl: base });
    expect(prisma.calendarFeed.create.mock.calls[0][0].data.cleanerId).toBe('cp1');
    expect(prisma.cleanerProfile.findFirst).not.toHaveBeenCalled();
  });

  test("a manager cannot create a feed for another business's cleaner", async () => {
    prisma.cleanerProfile.findFirst.mockResolvedValue(null);
    await expect(service.createFeed({ businessId: 'b1', actor: owner, cleanerId: 'foreign', baseUrl: base })).rejects.toMatchObject({ status: 404 });
    expect(prisma.cleanerProfile.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign', businessId: 'b1' } });
  });

  test('is capped per user', async () => {
    prisma.calendarFeed.count.mockResolvedValue(service.MAX_ACTIVE_FEEDS_PER_USER);
    await expect(service.createFeed({ businessId: 'b1', actor: owner, baseUrl: base })).rejects.toMatchObject({ status: 422 });
  });

  test('other roles are refused', async () => {
    await expect(service.createFeed({ businessId: 'b1', actor: { id: 'x', businessRole: 'VIEWER' }, baseUrl: base })).rejects.toMatchObject({ status: 403 });
  });
});

describe('listFeeds / revokeFeed', () => {
  test('a cleaner only sees their own links; a manager sees the business', async () => {
    prisma.calendarFeed.findMany.mockResolvedValue([]);
    await service.listFeeds({ businessId: 'b1', actor: cleaner });
    expect(prisma.calendarFeed.findMany.mock.calls[0][0].where).toEqual({ businessId: 'b1', revokedAt: null, userId: 'u-cl' });
    await service.listFeeds({ businessId: 'b1', actor: owner });
    expect(prisma.calendarFeed.findMany.mock.calls[1][0].where).toEqual({ businessId: 'b1', revokedAt: null });
  });

  test('listing never exposes the hash or secret', async () => {
    prisma.calendarFeed.findMany.mockResolvedValue([{ id: 'f1', cleanerId: null, label: 'x', createdAt: new Date(), lastAccessedAt: null, tokenHash: 'SECRET' }]);
    expect(JSON.stringify(await service.listFeeds({ businessId: 'b1', actor: owner }))).not.toContain('SECRET');
  });

  test("a cleaner cannot revoke someone else's link", async () => {
    prisma.calendarFeed.findFirst.mockResolvedValue({ id: 'f1', userId: 'u-other' });
    await expect(service.revokeFeed({ businessId: 'b1', actor: cleaner, id: 'f1' })).rejects.toMatchObject({ status: 404 });
    expect(prisma.calendarFeed.update).not.toHaveBeenCalled();
  });

  test('a manager can revoke any link in their business', async () => {
    prisma.calendarFeed.findFirst.mockResolvedValue({ id: 'f1', userId: 'u-other' });
    await service.revokeFeed({ businessId: 'b1', actor: owner, id: 'f1' });
    expect(prisma.calendarFeed.update).toHaveBeenCalledWith({ where: { id: 'f1' }, data: { revokedAt: expect.any(Date) } });
  });
});

describe('serving a feed', () => {
  const TOKEN = 'a'.repeat(43);
  const feedRow = (over = {}) => ({
    id: 'f1', businessId: 'b1', cleanerId: null, userId: 'u-owner', revokedAt: null, lastAccessedAt: null,
    business: { name: 'Schoon BV' }, cleaner: null, ...over,
  });

  test('unknown, malformed and revoked tokens are all the same 404', async () => {
    prisma.calendarFeed.findUnique.mockResolvedValueOnce(null);
    await expect(service.renderForToken(TOKEN)).rejects.toMatchObject({ status: 404 });
    await expect(service.renderForToken('short')).rejects.toMatchObject({ status: 404 });
    prisma.calendarFeed.findUnique.mockResolvedValueOnce(feedRow({ revokedAt: new Date() }));
    await expect(service.renderForToken(TOKEN)).rejects.toMatchObject({ status: 404 });
  });

  test('the lookup is by hash of the presented token', async () => {
    prisma.calendarFeed.findUnique.mockResolvedValue(null);
    await service.renderForToken(TOKEN).catch(() => {});
    expect(prisma.calendarFeed.findUnique.mock.calls[0][0].where).toEqual({ tokenHash: service.hashToken(TOKEN) });
  });

  test('a business feed stops working once its creator is no longer an active manager', async () => {
    prisma.calendarFeed.findUnique.mockResolvedValue(feedRow());
    prisma.businessMember.findFirst.mockResolvedValue(null);
    await expect(service.renderForToken(TOKEN)).rejects.toMatchObject({ status: 404 });
  });

  test('a cleaner feed stops working when the cleaner is offboarded or suspended', async () => {
    for (const status of ['OFFBOARDED', 'SUSPENDED', 'PENDING']) {
      prisma.calendarFeed.findUnique.mockResolvedValue(feedRow({ cleanerId: 'cp1', cleaner: { status, user: { firstName: 'Piet' } } }));
      await expect(service.renderForToken(TOKEN)).rejects.toMatchObject({ status: 404 });
    }
  });

  test('a cleaner feed only queries that cleaner\'s assignments', async () => {
    prisma.calendarFeed.findUnique.mockResolvedValue(feedRow({ cleanerId: 'cp1', cleaner: { status: 'ACTIVE', user: { firstName: 'Piet' } } }));
    const out = await service.renderForToken(TOKEN);
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where.businessId).toBe('b1');
    expect(where.assignments).toEqual({ some: { cleanerId: 'cp1' } });
    expect(out).toContain('X-WR-CALNAME:Schoon BV · Piet');
  });

  test('a business feed is scoped to its own business and renders', async () => {
    prisma.calendarFeed.findUnique.mockResolvedValue(feedRow());
    prisma.businessMember.findFirst.mockResolvedValue({ id: 'm1' });
    const out = await service.renderForToken(TOKEN);
    expect(prisma.booking.findMany.mock.calls[0][0].where.businessId).toBe('b1');
    expect(prisma.booking.findMany.mock.calls[0][0].where.assignments).toBeUndefined();
    expect(out).toContain('X-WR-CALNAME:Schoon BV · Bookings');
  });

  test('a failing "last used" update never breaks the feed', async () => {
    prisma.calendarFeed.findUnique.mockResolvedValue(feedRow());
    prisma.businessMember.findFirst.mockResolvedValue({ id: 'm1' });
    prisma.calendarFeed.update.mockRejectedValue(new Error('db down'));
    await expect(service.renderForToken(TOKEN)).resolves.toContain('BEGIN:VCALENDAR');
  });
});
