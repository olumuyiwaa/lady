jest.mock('../src/config/database.js', () => ({ booking: { findMany: jest.fn() } }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({ expireCheckoutSession: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/modules/bookings/bookings.service', () => ({ cancelBooking: jest.fn() }));

const prisma = require('../src/config/database.js');
const { expireCheckoutSession } = require('../src/lib/stripeClient');
const bookingsService = require('../src/modules/bookings/bookings.service');
const { sweepUnpaidDeposits } = require('../src/workers/depositSweeper');
const { depositHoldMinutes } = require('../src/lib/depositHold');

beforeEach(() => { jest.clearAllMocks(); delete process.env.DEPOSIT_HOLD_MINUTES; });

test('only REQUESTED, unassigned, unpaid-deposit bookings past the hold window are selected', async () => {
  prisma.booking.findMany.mockResolvedValue([]);
  const now = new Date('2026-06-15T12:00:00Z');
  await sweepUnpaidDeposits({ now });
  const where = prisma.booking.findMany.mock.calls[0][0].where;
  expect(where).toMatchObject({ status: 'REQUESTED', depositPaidAt: null, assignments: { none: {} }, depositRequiredCents: { gt: 0 } });
  expect(where.createdAt.lt.toISOString()).toBe('2026-06-15T10:45:00.000Z'); // 60 min hold + 15 min grace
});

test('expires the Stripe session then cancels with the fee waived; one failure does not stop the rest', async () => {
  prisma.booking.findMany.mockResolvedValue([
    { id: 'b1', businessId: 'x', stripeDepositSessionId: 'cs1', business: { stripeConnectedAccountId: 'acct' } },
    { id: 'b2', businessId: 'x', stripeDepositSessionId: 'cs2', business: { stripeConnectedAccountId: 'acct' } },
  ]);
  bookingsService.cancelBooking.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({});
  const stats = await sweepUnpaidDeposits();
  expect(stats).toEqual({ scanned: 2, cancelled: 1, errors: 1 });
  expect(expireCheckoutSession).toHaveBeenCalledWith('cs1', 'acct');
  expect(bookingsService.cancelBooking).toHaveBeenCalledWith('x', 'b2', null, 'Deposit was not paid in time', { waiveFee: true });
});

test('hold window is clamped to Stripe limits (30 min - 24 h)', () => {
  process.env.DEPOSIT_HOLD_MINUTES = '5';
  expect(depositHoldMinutes()).toBe(30);
  process.env.DEPOSIT_HOLD_MINUTES = '99999';
  expect(depositHoldMinutes()).toBe(1440);
  delete process.env.DEPOSIT_HOLD_MINUTES;
  expect(depositHoldMinutes()).toBe(60);
});
