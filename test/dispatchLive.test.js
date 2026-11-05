jest.mock('../src/config/database', () => ({
  cleanerProfile: { findMany: jest.fn(), update: jest.fn() },
  booking: { findMany: jest.fn() },
}));
const prisma = require('../src/config/database');
const { getLiveBoard, cleanerState } = require('../src/modules/dispatch/dispatch.live');
const { updateMyLocation } = require('../src/modules/cleanerSelf/cleanerSelf.service');

const NOW = new Date('2026-11-05T10:00:00Z').getTime();
const hr = (h) => new Date(NOW + h * 3600e3);
const booking = (id, startH, endH, extra = {}) => ({
  id, status: 'ASSIGNED', scheduledStart: hr(startH), scheduledEnd: hr(endH), addressLine1: 'Dam 1', city: 'Amsterdam',
  latitude: 52.37, longitude: 4.89, customer: { firstName: 'Ann', lastName: 'B' }, service: { name: 'Standard' }, assignments: [], ...extra,
});

describe('cleanerState', () => {
  test('checked in -> ON_JOB, on my way -> EN_ROUTE, later job -> NEXT_UP, none -> IDLE', () => {
    const b = booking('b', 1, 3);
    expect(cleanerState([{ checkedInAt: hr(-1), booking: b }], NOW).state).toBe('ON_JOB');
    expect(cleanerState([{ onMyWayAt: hr(-0.1), booking: b }], NOW).state).toBe('EN_ROUTE');
    expect(cleanerState([{ booking: b }], NOW).state).toBe('NEXT_UP');
    expect(cleanerState([{ checkedInAt: hr(-3), checkedOutAt: hr(-1), booking: booking('c', -3, -1) }], NOW).state).toBe('IDLE');
    expect(cleanerState([], NOW).state).toBe('IDLE');
  });
});

describe('getLiveBoard', () => {
  test('combines positions, states and unassigned jobs; flags stale positions', async () => {
    prisma.cleanerProfile.findMany.mockResolvedValue([
      { id: 'c1', user: { firstName: 'Eva', lastName: 'D', phone: '1' }, lastKnownLat: 52.1, lastKnownLng: 4.3, lastKnownAt: hr(-0.1) },
      { id: 'c2', user: { firstName: 'Tom', lastName: 'K' }, lastKnownLat: null, lastKnownLng: null, lastKnownAt: null },
    ]);
    const a1 = { cleanerId: 'c1', checkedInAt: hr(-0.5), checkedOutAt: null };
    prisma.booking.findMany.mockResolvedValue([
      booking('b1', -0.5, 2, { assignments: [a1] }),
      booking('b2', 3, 5),
    ]);
    const out = await getLiveBoard('biz', NOW);
    const c1 = out.cleaners.find((c) => c.id === 'c1');
    const c2 = out.cleaners.find((c) => c.id === 'c2');
    expect(c1.state).toBe('ON_JOB');
    expect(c1.stale).toBe(false);
    expect(c1.job.bookingId).toBe('b1');
    expect(c2.state).toBe('IDLE');
    expect(c2.stale).toBe(true);
    expect(c2.latitude).toBeNull();
    expect(out.jobs.find((j) => j.bookingId === 'b2').unassigned).toBe(true);
    expect(out.jobs.find((j) => j.bookingId === 'b1').unassigned).toBe(false);
  });
});

describe('updateMyLocation', () => {
  beforeEach(() => jest.clearAllMocks());
  test('rejects invalid coordinates', async () => {
    await expect(updateMyLocation({ id: 'c' }, { latitude: 'x', longitude: 4 })).rejects.toMatchObject({ status: 422 });
    await expect(updateMyLocation({ id: 'c' }, { latitude: 95, longitude: 4 })).rejects.toMatchObject({ status: 422 });
  });
  test('stores a ping, ignores one that follows too quickly', async () => {
    prisma.cleanerProfile.update.mockResolvedValue({});
    expect(await updateMyLocation({ id: 'c', lastKnownAt: null }, { latitude: 52, longitude: 4 })).toEqual({ updated: true });
    expect(prisma.cleanerProfile.update).toHaveBeenCalledTimes(1);
    expect(await updateMyLocation({ id: 'c', lastKnownAt: new Date() }, { latitude: 52, longitude: 4 })).toEqual({ updated: false });
    expect(prisma.cleanerProfile.update).toHaveBeenCalledTimes(1);
  });
});
