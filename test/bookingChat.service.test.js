jest.mock('../src/config/database.js', () => ({
  booking: { findFirst: jest.fn(), findMany: jest.fn() },
  conversation: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn() },
  message: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), count: jest.fn(), updateMany: jest.fn() },
  user: { findMany: jest.fn() },
  business: { findUnique: jest.fn() },
}));
jest.mock('../src/lib/notificationClient', () => ({ sendSms: jest.fn(), sendEmail: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({ pushToCleanerByUserId: jest.fn() }));

const prisma = require('../src/config/database.js');
const notifications = require('../src/modules/notifications/notifications.service');
const notificationClient = require('../src/lib/notificationClient');
const chat = require('../src/modules/bookingChat/bookingChat.service');

const customerParty = { type: 'CUSTOMER', customerId: 'cust1', userId: 'portal-user' };
const cleanerParty = { type: 'CLEANER', cleanerId: 'cl1', userId: 'cleaner-user' };

const booking = (over = {}) => ({
  id: 'bk1',
  businessId: 'biz1',
  status: 'ASSIGNED',
  updatedAt: new Date(),
  customer: { id: 'cust1', firstName: 'Anna', lastName: 'B', email: 'anna@x.nl', phone: '+31600000000' },
  assignments: [{ cleanerId: 'cl1', checkedOutAt: null, cleaner: { id: 'cl1', userId: 'cleaner-user', user: { id: 'cleaner-user', firstName: 'Piet', lastName: 'J' } } }],
  ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  prisma.booking.findFirst.mockResolvedValue(booking());
  prisma.conversation.findFirst.mockResolvedValue({ id: 'conv1' });
  prisma.message.count.mockResolvedValue(0);
  prisma.message.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.message.findFirst.mockResolvedValue(null);
  prisma.message.create.mockImplementation(async ({ data }) => ({ id: 'm1', createdAt: new Date(), ...data }));
  prisma.business.findUnique.mockResolvedValue({ name: 'Tod' });
  notifications.pushToCleanerByUserId.mockResolvedValue(undefined);
});

describe('access', () => {
  test('a customer only reaches their own booking', async () => {
    await chat.listMessages('biz1', 'bk1', customerParty);
    expect(prisma.booking.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'bk1', businessId: 'biz1', customerId: 'cust1' });
  });
  test('a cleaner only reaches bookings they are assigned to', async () => {
    await chat.listMessages('biz1', 'bk1', cleanerParty);
    expect(prisma.booking.findFirst.mock.calls[0][0].where.assignments).toEqual({ some: { cleanerId: 'cl1' } });
  });
  test("someone else's booking is a 404 for both reading and posting", async () => {
    prisma.booking.findFirst.mockResolvedValue(null);
    await expect(chat.listMessages('biz1', 'bk1', customerParty)).rejects.toMatchObject({ status: 404 });
    await expect(chat.postMessage('biz1', 'bk1', customerParty, { body: 'hi' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('chatState', () => {
  test('closed until a cleaner is assigned', () => {
    expect(chat.chatState(booking({ assignments: [] }))).toEqual({ open: false, reason: 'NO_CLEANER' });
  });
  test('closed when cancelled', () => {
    expect(chat.chatState(booking({ status: 'CANCELLED' }))).toMatchObject({ open: false, reason: 'CANCELLED' });
  });
  test('open for 48h after completion, closed after', () => {
    const now = Date.now();
    const done = (hoursAgo) =>
      booking({ status: 'COMPLETED', updatedAt: new Date(now - hoursAgo * 3600e3) });
    expect(chat.chatState(done(47), now).open).toBe(true);
    expect(chat.chatState(done(49), now)).toMatchObject({ open: false, reason: 'CLOSED' });
  });
});

describe('postMessage', () => {
  test('rejects empty and over-long messages', async () => {
    await expect(chat.postMessage('biz1', 'bk1', customerParty, { body: '   ' })).rejects.toMatchObject({ status: 422 });
    await expect(chat.postMessage('biz1', 'bk1', customerParty, { body: 'x'.repeat(chat.MAX_MESSAGE_LENGTH + 1) })).rejects.toMatchObject({ status: 422 });
  });
  test('refuses to post when no cleaner is assigned or the booking is cancelled', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ assignments: [] }));
    await expect(chat.postMessage('biz1', 'bk1', customerParty, { body: 'hi' })).rejects.toMatchObject({ status: 409 });
    prisma.booking.findFirst.mockResolvedValue(booking({ status: 'CANCELLED' }));
    await expect(chat.postMessage('biz1', 'bk1', customerParty, { body: 'hi' })).rejects.toMatchObject({ status: 409 });
  });
  test('rate limits a flood of messages', async () => {
    prisma.message.count.mockResolvedValue(30);
    await expect(chat.postMessage('biz1', 'bk1', customerParty, { body: 'hi' })).rejects.toMatchObject({ status: 429 });
  });
  test('a customer message is stored under the booking conversation and pushed to the cleaner', async () => {
    const m = await chat.postMessage('biz1', 'bk1', customerParty, { body: '  The key is under the mat  ' });
    expect(prisma.message.create.mock.calls[0][0].data).toEqual({ conversationId: 'conv1', senderUserId: 'portal-user', body: 'The key is under the mat' });
    expect(m).toMatchObject({ role: 'CUSTOMER', mine: true, body: 'The key is under the mat' });
    await new Promise((r) => setImmediate(r));
    expect(notifications.pushToCleanerByUserId).toHaveBeenCalledWith('cleaner-user', expect.objectContaining({ data: { type: 'BOOKING_MESSAGE', bookingId: 'bk1' } }));
  });
  test('creates the conversation on first use', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    prisma.conversation.create.mockResolvedValue({ id: 'conv-new' });
    await chat.postMessage('biz1', 'bk1', customerParty, { body: 'hello' });
    expect(prisma.conversation.create).toHaveBeenCalledWith({ data: { businessId: 'biz1', subjectType: 'BOOKING', subjectId: 'bk1' } });
  });
  test('a cleaner reply emails the customer, but not twice within 10 minutes', async () => {
    await chat.postMessage('biz1', 'bk1', cleanerParty, { body: 'On my way' });
    await new Promise((r) => setImmediate(r));
    expect(notificationClient.sendEmail).toHaveBeenCalledTimes(1);

    notificationClient.sendEmail.mockClear();
    prisma.message.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 2 * 60e3) });
    await chat.postMessage('biz1', 'bk1', cleanerParty, { body: 'Almost there' });
    await new Promise((r) => setImmediate(r));
    expect(notificationClient.sendEmail).not.toHaveBeenCalled();
  });
});

describe('listMessages', () => {
  test('labels roles, hides emails, and marks the other side read', async () => {
    prisma.message.findMany.mockResolvedValue([
      { id: 'a', senderUserId: 'portal-user', body: 'hi', createdAt: new Date(), readAt: null },
      { id: 'b', senderUserId: 'cleaner-user', body: 'hello', createdAt: new Date(), readAt: null },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'portal-user', email: 'portal-cust1@portal.invalid', firstName: 'Anna' },
      { id: 'cleaner-user', email: 'piet@tod.nl', firstName: 'Piet' },
    ]);
    const r = await chat.listMessages('biz1', 'bk1', customerParty);
    expect(r.open).toBe(true);
    expect(r.with).toBe('Piet');
    expect(r.messages.map((m) => [m.role, m.mine])).toEqual([['CUSTOMER', true], ['CLEANER', false]]);
    expect(JSON.stringify(r)).not.toContain('piet@tod.nl');
    expect(prisma.message.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['b'] } }, data: { readAt: expect.any(Date) } });
  });
  test('returns an empty thread when nobody has written yet', async () => {
    prisma.conversation.findFirst.mockResolvedValue(null);
    const r = await chat.listMessages('biz1', 'bk1', customerParty);
    expect(r.messages).toEqual([]);
  });
});
