/**
 * Covers the waitlist gap: previously, if a customer wanted a slot with no
 * availability, the widget just threw a 422 and that was the end of it —
 * no way to capture the demand or notify anyone when capacity freed up.
 */
jest.mock('../src/config/database.js', () => ({
  service: { findFirst: jest.fn() },
  waitlistEntry: { create: jest.fn(), findMany: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
  business: { findUnique: jest.fn() },
}));
jest.mock('../src/lib/scheduler', () => ({ findAvailableCleaners: jest.fn() }));
jest.mock('../src/lib/notificationClient', () => ({ sendSms: jest.fn(), sendEmail: jest.fn() }));

const mockPrisma = require('../src/config/database.js');
const { findAvailableCleaners } = require('../src/lib/scheduler');
const notificationClient = require('../src/lib/notificationClient');
const waitlistService = require('../src/modules/waitlist/waitlist.service');

describe('waitlist.service.joinWaitlist', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects a window where desiredEnd is not after desiredStart', async () => {
    await expect(
      waitlistService.joinWaitlist('biz1', {
        desiredStart: '2026-10-01T10:00:00Z',
        desiredEnd: '2026-10-01T09:00:00Z',
        contactEmail: 'a@b.com',
      })
    ).rejects.toThrow(/desiredEnd must be after desiredStart/);
  });

  test('requires at least one contact method', async () => {
    await expect(
      waitlistService.joinWaitlist('biz1', {
        desiredStart: '2026-10-01T09:00:00Z',
        desiredEnd: '2026-10-01T11:00:00Z',
      })
    ).rejects.toThrow(/contactEmail or contactPhone is required/);
  });

  test('creates a WAITING entry when the request is valid', async () => {
    mockPrisma.waitlistEntry.create.mockResolvedValue({ id: 'w1', status: 'WAITING' });
    const result = await waitlistService.joinWaitlist('biz1', {
      desiredStart: '2026-10-01T09:00:00Z',
      desiredEnd: '2026-10-01T11:00:00Z',
      contactPhone: '+15551234567',
    });
    expect(mockPrisma.waitlistEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ businessId: 'biz1', contactPhone: '+15551234567' }) })
    );
    expect(result.status).toBe('WAITING');
  });

  test('404s when serviceId is given but does not belong to this business', async () => {
    mockPrisma.service.findFirst.mockResolvedValue(null);
    await expect(
      waitlistService.joinWaitlist('biz1', {
        desiredStart: '2026-10-01T09:00:00Z',
        desiredEnd: '2026-10-01T11:00:00Z',
        contactEmail: 'a@b.com',
        serviceId: 'nope',
      })
    ).rejects.toThrow(/Service not found/);
  });
});

describe('waitlist.service.notifyWaitlistForFreedSlot', () => {
  beforeEach(() => jest.clearAllMocks());

  const freedSlot = {
    serviceId: 'svc1',
    scheduledStart: '2026-10-01T09:00:00Z',
    scheduledEnd: '2026-10-01T11:00:00Z',
  };

  test('does nothing when no waitlist entries overlap the freed window', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([]);
    const result = await waitlistService.notifyWaitlistForFreedSlot('biz1', freedSlot);
    expect(result).toEqual({ notified: 0 });
    expect(findAvailableCleaners).not.toHaveBeenCalled();
  });

  test('does not notify anyone if no cleaner can actually cover the freed slot', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([{ id: 'w1', contactEmail: 'a@b.com' }]);
    findAvailableCleaners.mockResolvedValue([]);
    const result = await waitlistService.notifyWaitlistForFreedSlot('biz1', freedSlot);
    expect(result).toEqual({ notified: 0 });
    expect(notificationClient.sendEmail).not.toHaveBeenCalled();
  });

  test('notifies matching entries by SMS and/or email and marks them NOTIFIED', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([
      { id: 'w1', contactEmail: 'a@b.com', contactPhone: null },
      { id: 'w2', contactEmail: null, contactPhone: '+15551234567' },
    ]);
    findAvailableCleaners.mockResolvedValue([{ cleanerId: 'c1' }]);
    mockPrisma.business.findUnique.mockResolvedValue({ name: 'Sparkle Co' });

    const result = await waitlistService.notifyWaitlistForFreedSlot('biz1', freedSlot);

    expect(notificationClient.sendEmail).toHaveBeenCalledTimes(1);
    expect(notificationClient.sendSms).toHaveBeenCalledTimes(1);
    expect(mockPrisma.waitlistEntry.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: { status: 'NOTIFIED', notifiedAt: expect.any(Date) },
    });
    expect(result).toEqual({ notified: 2 });
  });

  test('one failed notification does not stop the rest from being notified', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([
      { id: 'w1', contactEmail: 'bad@b.com', contactPhone: null },
      { id: 'w2', contactEmail: 'ok@b.com', contactPhone: null },
    ]);
    findAvailableCleaners.mockResolvedValue([{ cleanerId: 'c1' }]);
    mockPrisma.business.findUnique.mockResolvedValue({ name: 'Sparkle Co' });
    notificationClient.sendEmail.mockRejectedValueOnce(new Error('smtp down')).mockResolvedValueOnce({});

    const result = await waitlistService.notifyWaitlistForFreedSlot('biz1', freedSlot);

    expect(result).toEqual({ notified: 1 });
  });
});
