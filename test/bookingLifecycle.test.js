jest.mock('../src/config/database.js', () => {
  const db = {
    booking: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    cleanerProfile: { findFirst: jest.fn(), findUnique: jest.fn() },
    bookingAssignment: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), deleteMany: jest.fn(), delete: jest.fn() },
    jobPhoto: { count: jest.fn() },
    jobChecklist: { update: jest.fn() },
    auditLog: { create: jest.fn() },
    business: { findUnique: jest.fn() },
  };
  db.$transaction = jest.fn((fn) => fn(db));
  return db;
});
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({
  notifyBookingConfirmed: jest.fn(), notifyCleanerAssigned: jest.fn(), notifyCleanerUnassigned: jest.fn(),
  requestReview: jest.fn(), sendCustomerPaymentLink: jest.fn(), notifyBookingRescheduled: jest.fn(),
}));
jest.mock('../src/modules/payroll/payroll.service', () => ({ computeEarningsForBooking: jest.fn() }));
jest.mock('../src/lib/assignmentConflicts', () => ({ assertCleanerFree: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({
  createBookingCheckoutSession: jest.fn(),
  createAncillaryCheckoutSession: jest.fn(), createRefund: jest.fn(), expireCheckoutSession: jest.fn(),
}));

const prisma = require('../src/config/database.js');
const notifications = require('../src/modules/notifications/notifications.service');
const payroll = require('../src/modules/payroll/payroll.service');
const bookings = require('../src/modules/bookings/bookings.service');
const sm = require('../src/lib/bookingStateMachine');
const stripeClient = require('../src/lib/stripeClient');

const cleaner = { id: 'cl1', businessId: 'biz', status: 'ACTIVE', userId: 'u1', business: { id: 'biz' } };
const bk = (over = {}) => ({
  id: 'bk1', businessId: 'biz', status: 'CONFIRMED', scheduledStart: new Date('2099-06-01T08:00:00Z'), scheduledEnd: new Date('2099-06-01T10:00:00Z'),
  quotedPriceCents: 8000, paymentStatus: 'PAID', customer: { id: 'c1', firstName: 'A' }, service: { name: 'S' }, assignments: [],
  business: { stripeChargesEnabled: true, stripeConnectedAccountId: 'acct' }, checklist: null, ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
  prisma.booking.update.mockImplementation(async ({ data }) => ({ ...bk(), ...data }));
  prisma.cleanerProfile.findFirst.mockResolvedValue(cleaner);
  prisma.cleanerProfile.findUnique.mockResolvedValue({ userId: 'u1' });
  prisma.bookingAssignment.create.mockResolvedValue({ id: 'as1' });
  prisma.business.findUnique.mockResolvedValue({ stripeChargesEnabled: true, stripeConnectedAccountId: 'acct', currency: 'eur' });
  stripeClient.createBookingCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://pay/cs_1' });
});

describe('state machine helpers', () => {
  test('terminal statuses cannot be changed', () => {
    expect(() => sm.assertOpen({ status: 'CANCELLED' }, 'assign a cleaner to')).toThrow(expect.objectContaining({ status: 409, message: 'Cannot assign a cleaner to a booking that is cancelled' }));
    expect(() => sm.assertOpen({ status: 'COMPLETED' })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => sm.assertOpen({ status: 'IN_PROGRESS' })).not.toThrow();
  });
  test('assign only moves REQUESTED/CONFIRMED to ASSIGNED; unassign only falls back when nobody is left', () => {
    expect(sm.statusAfterAssign('REQUESTED')).toBe('ASSIGNED');
    expect(sm.statusAfterAssign('CONFIRMED')).toBe('ASSIGNED');
    expect(sm.statusAfterAssign('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(sm.statusAfterUnassign('ASSIGNED', 0)).toBe('CONFIRMED');
    expect(sm.statusAfterUnassign('ASSIGNED', 1)).toBe('ASSIGNED');
    expect(sm.statusAfterUnassign('IN_PROGRESS', 0)).toBe('IN_PROGRESS');
  });
});

describe('assign / confirm can no longer revive or rewind a booking', () => {
  test.each(['CANCELLED', 'COMPLETED'])('assigning a %s booking is refused and nothing is written', async (status) => {
    prisma.booking.findFirst.mockResolvedValue(bk({ status }));
    await expect(bookings.assignBooking('biz', 'bk1', 'cl1', 'u')).rejects.toMatchObject({ status: 409 });
    expect(prisma.bookingAssignment.create).not.toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });
  test('adding a second cleaner to an in-progress job does not reset its status', async () => {
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'IN_PROGRESS' }));
    await bookings.assignBooking('biz', 'bk1', 'cl1', 'u');
    expect(prisma.bookingAssignment.create).toHaveBeenCalled();
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });
  test('assigning a CONFIRMED booking moves it to ASSIGNED', async () => {
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'CONFIRMED' }));
    await bookings.assignBooking('biz', 'bk1', 'cl1', 'u');
    expect(prisma.booking.update).toHaveBeenCalledWith({ where: { id: 'bk1' }, data: { status: 'ASSIGNED' } });
  });
  test('confirm: REQUESTED -> CONFIRMED and the customer is told', async () => {
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'REQUESTED' }));
    const r = await bookings.confirmBooking('biz', 'bk1', 'u');
    expect(r.status).toBe('CONFIRMED');
    expect(notifications.notifyBookingConfirmed).toHaveBeenCalledTimes(1);
  });
  test.each(['CONFIRMED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED'])('confirming a %s booking is a no-op (never moves it backwards)', async (status) => {
    prisma.booking.findFirst.mockResolvedValue(bk({ status }));
    const r = await bookings.confirmBooking('biz', 'bk1', 'u');
    expect(r.status).toBe(status);
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(notifications.notifyBookingConfirmed).not.toHaveBeenCalled();
  });
  test('confirming a cancelled booking is a 409', async () => {
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'CANCELLED' }));
    await expect(bookings.confirmBooking('biz', 'bk1', 'u')).rejects.toMatchObject({ status: 409 });
  });
});

describe('dispatch board unassign', () => {
  const dispatch = require('../src/modules/dispatch/dispatch.service');
  test('team job: removing one cleaner leaves the booking ASSIGNED', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue({ id: 'as1', bookingId: 'bk1', cleanerId: 'cl1', checkedInAt: null });
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'ASSIGNED' }));
    prisma.bookingAssignment.count.mockResolvedValue(1);
    await dispatch.deleteAssignment('biz', 'as1');
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(notifications.notifyCleanerUnassigned).toHaveBeenCalled();
  });
  test('last cleaner removed: back to CONFIRMED', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue({ id: 'as1', bookingId: 'bk1', cleanerId: 'cl1', checkedInAt: null });
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'ASSIGNED' }));
    prisma.bookingAssignment.count.mockResolvedValue(0);
    await dispatch.deleteAssignment('biz', 'as1');
    expect(prisma.booking.update).toHaveBeenCalledWith({ where: { id: 'bk1' }, data: { status: 'CONFIRMED' } });
  });
  test('cannot unassign from a completed job or a cleaner who already started', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue({ id: 'as1', bookingId: 'bk1', cleanerId: 'cl1', checkedInAt: null });
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'COMPLETED' }));
    await expect(dispatch.deleteAssignment('biz', 'as1')).rejects.toMatchObject({ status: 409 });
    prisma.bookingAssignment.findFirst.mockResolvedValue({ id: 'as1', bookingId: 'bk1', cleanerId: 'cl1', checkedInAt: new Date() });
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'IN_PROGRESS' }));
    await expect(dispatch.deleteAssignment('biz', 'as1')).rejects.toMatchObject({ status: 409 });
    expect(prisma.bookingAssignment.delete).not.toHaveBeenCalled();
  });
  test('manual dispatch assignment notifies the cleaner and is audited as manual', async () => {
    const { audit } = require('../src/utils/audit');
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'CONFIRMED' }));
    prisma.cleanerProfile.findFirst.mockResolvedValue(cleaner);
    prisma.bookingAssignment.findFirst.mockResolvedValue(null);
    await dispatch.createAssignment('biz', 'bk1', 'cl1', 'u');
    expect(notifications.notifyCleanerAssigned).toHaveBeenCalledWith('biz', expect.anything(), 'u1');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISPATCH_MANUAL_ASSIGNED' }));
  });
});

describe('one completion implementation', () => {
  test('dashboard completion: sends review + payment link for an unpaid booking, and stamps missing check-outs before payroll', async () => {
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'ASSIGNED', paymentStatus: 'UNPAID' }));
    prisma.booking.findUnique.mockResolvedValue(bk({ paymentStatus: 'UNPAID' }));
    const order = [];
    prisma.bookingAssignment.updateMany.mockImplementation(async () => { order.push('stamp'); });
    payroll.computeEarningsForBooking.mockImplementation(async () => { order.push('payroll'); });

    await bookings.completeBooking('biz', 'bk1', 'u');

    expect(prisma.booking.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'COMPLETED' } }));
    expect(notifications.requestReview).toHaveBeenCalledTimes(1);
    expect(notifications.sendCustomerPaymentLink).toHaveBeenCalledWith('biz', expect.anything(), expect.anything(), 'https://pay/cs_1');
    expect(order).toEqual(['stamp', 'payroll']);
    expect(prisma.bookingAssignment.updateMany).toHaveBeenCalledWith({ where: { bookingId: 'bk1', checkedInAt: { not: null }, checkedOutAt: null }, data: { checkedOutAt: expect.any(Date) } });
  });

  test('completing twice is idempotent: no second review request or payment link', async () => {
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'COMPLETED' }));
    await bookings.completeBooking('biz', 'bk1', 'u');
    expect(notifications.requestReview).not.toHaveBeenCalled();
    expect(notifications.sendCustomerPaymentLink).not.toHaveBeenCalled();
  });

  test('a cancelled booking cannot be completed', async () => {
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'CANCELLED' }));
    await expect(bookings.completeBooking('biz', 'bk1', 'u')).rejects.toMatchObject({ status: 422 });
  });
});

describe('completion by a cleaner', () => {
  const assignment = (over = {}) => ({ id: 'as1', bookingId: 'bk1', isTeamLead: false, checkedInAt: new Date(), cleaner, booking: bk(), ...over });
  beforeEach(() => {
    prisma.jobPhoto.count.mockResolvedValue(1);
    prisma.booking.findFirst.mockResolvedValue(bk({ status: 'IN_PROGRESS', paymentStatus: 'PAID' }));
    prisma.booking.findUnique.mockResolvedValue(bk({ status: 'IN_PROGRESS' }));
  });

  test('is resolved through the assignment (a cleaner working for two businesses completes the right booking)', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue(assignment());
    prisma.bookingAssignment.count.mockResolvedValue(0);
    await bookings.completeBookingByCleaner('bk1', 'u1');
    expect(prisma.bookingAssignment.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { bookingId: 'bk1', cleaner: { userId: 'u1', status: 'ACTIVE' } } }));
    expect(prisma.booking.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'COMPLETED' } }));
  });

  test('not assigned -> 403', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue(null);
    await expect(bookings.completeBookingByCleaner('bk1', 'u1')).rejects.toMatchObject({ status: 403 });
  });

  test('team job: a helper checking out first does NOT complete the job for everyone', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue(assignment({ isTeamLead: false }));
    prisma.bookingAssignment.count.mockResolvedValue(1); // the lead is still on site
    const r = await bookings.completeBookingByCleaner('bk1', 'u1');
    expect(r.awaitingTeam).toBe(true);
    expect(prisma.booking.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'COMPLETED' } }));
    expect(prisma.bookingAssignment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ checkedOutAt: expect.any(Date) }) }));
  });

  test('team job: the team lead completes for everyone', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue(assignment({ isTeamLead: true }));
    prisma.bookingAssignment.count.mockResolvedValue(2);
    await bookings.completeBookingByCleaner('bk1', 'u1');
    expect(prisma.booking.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'COMPLETED' } }));
  });

  test('team job: the last helper on site completes it', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue(assignment({ isTeamLead: false }));
    prisma.bookingAssignment.count.mockResolvedValue(0);
    await bookings.completeBookingByCleaner('bk1', 'u1');
    expect(prisma.booking.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'COMPLETED' } }));
  });

  test('an after-photo is still required', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue(assignment());
    prisma.jobPhoto.count.mockResolvedValue(0);
    await expect(bookings.completeBookingByCleaner('bk1', 'u1')).rejects.toMatchObject({ code: 'PHOTO_PROOF_REQUIRED' });
  });
});
