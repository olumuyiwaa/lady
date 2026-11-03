jest.mock('../src/config/database.js', () => ({
  businessMember: { findFirst: jest.fn() },
  cleanerProfile: { findFirst: jest.fn() },
  conversation: { findFirst: jest.fn() },
}));
const prisma = require('../src/config/database.js');
const { resolveRealtimeRole, canJoinConversation } = require('../src/lib/realtimeAccess');

describe('realtime access', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.businessMember.findFirst.mockResolvedValue(null);
    prisma.cleanerProfile.findFirst.mockResolvedValue(null);
  });

  test('staff are staff; an active cleaner is not staff (no tenant-wide booking events)', async () => {
    prisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'cl1' });
    expect(await resolveRealtimeRole('u1', 'biz1')).toMatchObject({ isStaff: false, isCleaner: true });
    prisma.businessMember.findFirst.mockResolvedValue({ id: 'm1' });
    expect((await resolveRealtimeRole('u2', 'biz1')).isStaff).toBe(true);
  });

  test('no business in the token means no roles', async () => {
    expect(await resolveRealtimeRole('u1', null)).toEqual({ isStaff: false, isCleaner: false });
  });

  test('a conversation in another tenant cannot be joined', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null); // scoped by businessId, so not found
    expect(await canJoinConversation('u1', 'biz1', 'conv-of-other-tenant')).toBe(false);
    expect(prisma.conversation.findFirst.mock.calls[0][0].where).toEqual({ id: 'conv-of-other-tenant', businessId: 'biz1' });
  });

  test('staff can join any conversation in their business', async () => {
    prisma.conversation.findFirst.mockResolvedValue({ subjectType: 'CLEANER', subjectId: 'cl9' });
    prisma.businessMember.findFirst.mockResolvedValue({ id: 'm1' });
    expect(await canJoinConversation('u1', 'biz1', 'c1')).toBe(true);
  });

  test("a cleaner can join only their own conversation, not a colleague's", async () => {
    prisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'cl1' });
    prisma.conversation.findFirst.mockResolvedValue({ subjectType: 'CLEANER', subjectId: 'cl1' });
    expect(await canJoinConversation('u1', 'biz1', 'c1')).toBe(true);
    prisma.conversation.findFirst.mockResolvedValue({ subjectType: 'CLEANER', subjectId: 'cl2' });
    expect(await canJoinConversation('u1', 'biz1', 'c2')).toBe(false);
  });

  test('a cleaner cannot join a customer conversation', async () => {
    prisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'cl1' });
    prisma.conversation.findFirst.mockResolvedValue({ subjectType: 'CUSTOMER', subjectId: 'cl1' });
    expect(await canJoinConversation('u1', 'biz1', 'c3')).toBe(false);
  });

  test('rejects malformed input', async () => {
    expect(await canJoinConversation('u1', 'biz1', { $ne: null })).toBe(false);
    expect(await canJoinConversation('u1', 'biz1', '')).toBe(false);
  });
});
