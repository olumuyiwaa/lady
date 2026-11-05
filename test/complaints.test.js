jest.mock('../src/config/database', () => ({
  booking: { findFirst: jest.fn() },
  supportTicket: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn() },
}));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({ notifyMembers: jest.fn() }));

const prisma = require('../src/config/database');
const notifications = require('../src/modules/notifications/notifications.service');
const sla = require('../src/lib/ticketSla');
const { createComplaint } = require('../src/modules/supportTickets/complaints.service');

const past = new Date(Date.now() - 3 * 3600e3);
const booking = (o = {}) => ({
  id: 'b1', status: 'COMPLETED', scheduledStart: past, customer: { firstName: 'Ann', lastName: 'B', email: 'A@x.nl', phone: '06' },
  service: { name: 'Standard' }, assignments: [{ cleanerId: 'c1' }], ...o,
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.booking.findFirst.mockResolvedValue(booking());
  prisma.supportTicket.findFirst.mockResolvedValue(null);
  prisma.supportTicket.create.mockImplementation(async ({ data }) => ({ id: 'tkt123456', ...data }));
});

describe('createComplaint', () => {
  test('creates a prioritised ticket linked to booking, customer and cleaner', async () => {
    const r = await createComplaint('biz', 'cust', 'b1', { category: 'damage', description: 'A vase was broken during the visit' });
    const data = prisma.supportTicket.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ kind: 'COMPLAINT', priority: 'URGENT', category: 'DAMAGE', bookingId: 'b1', customerId: 'cust', cleanerId: 'c1', contactEmail: 'a@x.nl', source: 'PORTAL' });
    expect(data.dueAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600e3);
    expect(r.priority).toBe('URGENT');
    expect(notifications.notifyMembers).toHaveBeenCalled();
  });

  test('rejects short descriptions and unknown categories', async () => {
    await expect(createComplaint('biz', 'cust', 'b1', { category: 'QUALITY', description: 'bad' })).rejects.toMatchObject({ status: 422 });
    await expect(createComplaint('biz', 'cust', 'b1', { category: 'NOPE', description: 'long enough text here' })).rejects.toMatchObject({ status: 422 });
  });

  test("404s for someone else's booking, 409 for future visits and duplicates", async () => {
    prisma.booking.findFirst.mockResolvedValue(null);
    await expect(createComplaint('biz', 'cust', 'b1', { description: 'long enough text here' })).rejects.toMatchObject({ status: 404 });
    prisma.booking.findFirst.mockResolvedValue(booking({ status: 'CONFIRMED', scheduledStart: new Date(Date.now() + 86400e3) }));
    await expect(createComplaint('biz', 'cust', 'b1', { description: 'long enough text here' })).rejects.toMatchObject({ status: 409 });
    prisma.booking.findFirst.mockResolvedValue(booking());
    prisma.supportTicket.findFirst.mockResolvedValue({ id: 'old' });
    await expect(createComplaint('biz', 'cust', 'b1', { description: 'long enough text here' })).rejects.toMatchObject({ status: 409 });
  });

  test('a notification failure never fails the complaint', async () => {
    notifications.notifyMembers.mockRejectedValue(new Error('boom'));
    await expect(createComplaint('biz', 'cust', 'b1', { description: 'long enough text here' })).resolves.toHaveProperty('id');
  });
});

describe('ticketSla', () => {
  const hr = (h) => new Date(Date.now() + h * 3600e3);
  test('slaState', () => {
    expect(sla.slaState({ status: 'RESOLVED', priority: 'LOW', createdAt: hr(-500) })).toBe('DONE');
    expect(sla.slaState({ status: 'OPEN', priority: 'URGENT', createdAt: hr(-30), dueAt: hr(-6) })).toBe('OVERDUE');
    expect(sla.slaState({ status: 'OPEN', priority: 'URGENT', createdAt: hr(-3), dueAt: hr(21) })).toBe('AT_RISK'); // no reply within 2h
    expect(sla.slaState({ status: 'OPEN', priority: 'URGENT', createdAt: hr(-3), dueAt: hr(21), firstResponseAt: hr(-2) })).toBe('OK');
  });
  test('summarise averages response and resolution times and counts complaints', () => {
    const t0 = hr(-10);
    const s = sla.summarise([
      { status: 'RESOLVED', priority: 'MEDIUM', kind: 'COMPLAINT', category: 'QUALITY', createdAt: t0, firstResponseAt: new Date(t0.getTime() + 2 * 3600e3), resolvedAt: new Date(t0.getTime() + 6 * 3600e3) },
      { status: 'OPEN', priority: 'URGENT', kind: 'COMPLAINT', category: 'DAMAGE', createdAt: hr(-30), dueAt: hr(-6) },
    ]);
    expect(s).toMatchObject({ open: 1, overdue: 1, complaintsOpen: 1, avgFirstResponseHours: 2, avgResolutionHours: 6, complaintsByCategory: { QUALITY: 1, DAMAGE: 1 } });
  });
});
