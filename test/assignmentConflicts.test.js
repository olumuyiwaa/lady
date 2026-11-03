jest.mock('../src/config/database.js', () => ({ bookingAssignment: { findFirst: jest.fn() } }));
const prisma = require('../src/config/database.js');
const { assertCleanerFree } = require('../src/lib/assignmentConflicts');

describe('assignmentConflicts', () => {
  beforeEach(() => jest.clearAllMocks());
  const start = new Date('2026-01-01T10:00:00Z');
  const end = new Date('2026-01-01T12:00:00Z');

  test('uses strict overlap so back-to-back jobs do not conflict', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue(null);
    await assertCleanerFree('cl1', start, end);
    const where = prisma.bookingAssignment.findFirst.mock.calls[0][0].where;
    expect(where.booking.scheduledStart).toEqual({ lt: end });
    expect(where.booking.scheduledEnd).toEqual({ gt: start });
    expect(where.booking.status).toEqual({ not: 'CANCELLED' });
  });

  test('a genuine overlap is a 409 naming the clashing booking', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue({ booking: { id: 'b9' } });
    await expect(assertCleanerFree('cl1', start, end)).rejects.toMatchObject({ status: 409, conflictingBookingId: 'b9' });
  });

  test('the booking being (re)assigned is excluded from its own conflict check', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue(null);
    await assertCleanerFree('cl1', start, end, { excludeBookingId: 'bk1' });
    expect(prisma.bookingAssignment.findFirst.mock.calls[0][0].where.bookingId).toEqual({ not: 'bk1' });
  });
});
