jest.mock('../src/config/database', () => ({
  supportTicket: { findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn() },
}));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({}));
jest.mock('../src/lib/contactMail', () => ({ oneLine: (s) => s, referenceFromId: (id) => id, sendTracked: jest.fn() }));

const prisma = require('../src/config/database');
const svc = require('../src/modules/supportTickets/supportTickets.service');

test('every exported name is a function (module loads)', () => {
  for (const k of Object.keys(svc)) expect(typeof svc[k]).toBe('function');
  expect(typeof svc.ticketStats).toBe('function');
});

test('ticketStats summarises tickets', async () => {
  prisma.supportTicket.findMany.mockResolvedValue([
    { status: 'OPEN', priority: 'URGENT', kind: 'COMPLAINT', category: 'DAMAGE', createdAt: new Date(Date.now() - 40 * 3600e3), dueAt: new Date(Date.now() - 3600e3) },
  ]);
  const r = await svc.ticketStats('biz', { days: 30 });
  expect(r).toMatchObject({ days: 30, open: 1, overdue: 1, complaintsOpen: 1 });
});

test('getTicket and listTickets attach slaState', async () => {
  const t = { id: 't', status: 'OPEN', priority: 'LOW', createdAt: new Date(), messages: [] };
  prisma.supportTicket.findFirst.mockResolvedValue(t);
  expect((await svc.getTicket('biz', 't')).slaState).toBe('OK');
  prisma.supportTicket.count.mockResolvedValue(1);
  prisma.supportTicket.findMany.mockResolvedValue([t]);
  expect((await svc.listTickets('biz')).data[0].slaState).toBe('OK');
});
