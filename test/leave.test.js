jest.mock('../src/config/database', () => ({
  business: { findUnique: jest.fn() },
  cleanerProfile: { findFirst: jest.fn() },
  cleanerLeave: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  bookingAssignment: { findMany: jest.fn() },
  auditLog: { create: jest.fn() },
}));
jest.mock('../src/modules/notifications/notifications.service', () => ({ pushToCleanerByUserId: jest.fn() }));
const prisma = require('../src/config/database');
const { leaveWindow, assertCleanerNotOnLeave, cleanersOnLeave } = require('../src/lib/leave');
const service = require('../src/modules/leave/leave.service');

beforeEach(() => {
  jest.resetAllMocks();
  prisma.business.findUnique.mockResolvedValue({ timezone: 'Europe/Amsterdam' });
  prisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'c1' });
  prisma.bookingAssignment.findMany.mockResolvedValue([]);
  prisma.auditLog.create.mockResolvedValue({});
});

describe('leaveWindow', () => {
  test('covers whole local days in the business time zone', () => {
    const w = leaveWindow('2030-01-10', '2030-01-11', 'Europe/Amsterdam');
    expect(w.startsAt.toISOString()).toBe('2030-01-09T23:00:00.000Z');
    expect(w.endsAt.toISOString()).toBe('2030-01-11T23:00:00.000Z');
  });
  test('handles summer time', () => {
    expect(leaveWindow('2030-07-01', '2030-07-01', 'Europe/Amsterdam').startsAt.toISOString()).toBe('2030-06-30T22:00:00.000Z');
  });
  test('rejects bad input', () => {
    expect(() => leaveWindow('10-01-2030', '2030-01-11')).toThrow(/YYYY-MM-DD/);
    expect(() => leaveWindow('2030-01-12', '2030-01-11')).toThrow(/on or after/);
    expect(() => leaveWindow('2030-01-01', '2030-06-01')).toThrow(/at most/);
  });
});

describe('blocking', () => {
  test('assertCleanerNotOnLeave throws 409 when approved leave overlaps', async () => {
    prisma.cleanerLeave.findFirst.mockResolvedValue({ id: 'l1' });
    await expect(assertCleanerNotOnLeave('c1', new Date(), new Date())).rejects.toMatchObject({ status: 409, leaveId: 'l1' });
    expect(prisma.cleanerLeave.findFirst.mock.calls[0][0].where).toMatchObject({ cleanerId: 'c1', status: 'APPROVED' });
  });
  test('assertCleanerNotOnLeave passes without leave', async () => {
    prisma.cleanerLeave.findFirst.mockResolvedValue(null);
    await expect(assertCleanerNotOnLeave('c1', new Date(), new Date())).resolves.toBeUndefined();
  });
  test('cleanersOnLeave returns ids', async () => {
    prisma.cleanerLeave.findMany.mockResolvedValue([{ cleanerId: 'c2' }]);
    const set = await cleanersOnLeave(['c1', 'c2'], new Date(), new Date());
    expect([...set]).toEqual(['c2']);
    expect((await cleanersOnLeave([], new Date(), new Date())).size).toBe(0);
  });
});

describe('workflow', () => {
  test('a cleaner request starts PENDING', async () => {
    prisma.cleanerLeave.findFirst.mockResolvedValue(null);
    prisma.cleanerLeave.create.mockImplementation(async ({ data }) => ({ id: 'l1', ...data }));
    const { leave } = await service.create({ businessId: 'b', cleanerId: 'c1', startDate: '2099-01-10', endDate: '2099-01-12' });
    expect(leave.status).toBeUndefined(); // db default PENDING
    expect(prisma.cleanerLeave.create.mock.calls[0][0].data.status).toBeUndefined();
  });
  test('manager-recorded leave is approved and lists conflicts', async () => {
    prisma.cleanerLeave.findFirst.mockResolvedValue(null);
    prisma.cleanerLeave.create.mockImplementation(async ({ data }) => ({ id: 'l1', ...data }));
    prisma.bookingAssignment.findMany.mockResolvedValue([{ booking: { id: 'bk1' } }]);
    const out = await service.create({ businessId: 'b', cleanerId: 'c1', startDate: '2099-01-10', endDate: '2099-01-12', createdById: 'u1', autoApprove: true });
    expect(out.leave.status).toBe('APPROVED');
    expect(out.conflicts).toEqual([{ id: 'bk1' }]);
  });
  test('rejects overlap with existing leave', async () => {
    prisma.cleanerLeave.findFirst.mockResolvedValue({ id: 'x' });
    await expect(service.create({ businessId: 'b', cleanerId: 'c1', startDate: '2099-01-10', endDate: '2099-01-12' })).rejects.toMatchObject({ status: 409 });
  });
  test('rejects leave fully in the past', async () => {
    await expect(service.create({ businessId: 'b', cleanerId: 'c1', startDate: '2020-01-10', endDate: '2020-01-12' })).rejects.toMatchObject({ status: 400 });
  });
  test('only pending can be approved', async () => {
    prisma.cleanerLeave.findFirst.mockResolvedValue({ id: 'l1', status: 'APPROVED', cleanerId: 'c1', cleaner: { userId: 'u' } });
    await expect(service.approve('b', 'l1', 'm')).rejects.toMatchObject({ status: 409 });
  });
  test('approve updates, notifies and returns conflicts', async () => {
    const start = new Date('2099-01-10'); const end = new Date('2099-01-13');
    prisma.cleanerLeave.findFirst.mockResolvedValue({ id: 'l1', status: 'PENDING', cleanerId: 'c1', startsAt: start, endsAt: end, cleaner: { userId: 'u9' } });
    prisma.cleanerLeave.update.mockResolvedValue({ id: 'l1', status: 'APPROVED' });
    const out = await service.approve('b', 'l1', 'm', 'enjoy');
    expect(out.leave.status).toBe('APPROVED');
    expect(prisma.cleanerLeave.update.mock.calls[0][0].data).toMatchObject({ status: 'APPROVED', decidedById: 'm', decisionNote: 'enjoy' });
    expect(require('../src/modules/notifications/notifications.service').pushToCleanerByUserId).toHaveBeenCalledWith('u9', expect.objectContaining({ title: 'Leave approved' }));
  });
  test("a cleaner cannot cancel someone else's leave", async () => {
    prisma.cleanerLeave.findFirst.mockResolvedValue({ id: 'l1', status: 'PENDING', cleanerId: 'other', endsAt: new Date('2099-01-01'), cleaner: {} });
    await expect(service.cancel('b', 'l1', { cleanerId: 'c1' })).rejects.toMatchObject({ status: 404 });
  });
});
