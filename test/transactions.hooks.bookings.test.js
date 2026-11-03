/** Payments recorded by hand, status flips and cancellation refunds all reach the log. */
jest.mock('../src/config/database.js', () => {
  const db = {
    booking: { findFirst: jest.fn(), update: jest.fn() },
    business: { findUnique: jest.fn() },
    giftCard: { findUnique: jest.fn(), update: jest.fn() },
    coupon: { updateMany: jest.fn() },
  };
  db.$transaction = jest.fn((fn) => fn(db));
  return db;
});
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({ notifyBookingCancelled: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({
  createBookingCheckoutSession: jest.fn(), createAncillaryCheckoutSession: jest.fn(), createRefund: jest.fn(), expireCheckoutSession: jest.fn(),
}));
jest.mock('../src/lib/cancellationPolicy', () => ({ evaluateCancellation: jest.fn() }));
jest.mock('../src/modules/transactions/transactions.service', () => ({ record: jest.fn(), reverseManualPayments: jest.fn() }));

const prisma = require('../src/config/database.js');
const { createRefund } = require('../src/lib/stripeClient');
const { evaluateCancellation } = require('../src/lib/cancellationPolicy');
const transactions = require('../src/modules/transactions/transactions.service');
const service = require('../src/modules/bookings/bookings.service');

const booking = (over = {}) => ({
  id: 'bk1', businessId: 'biz1', customerId: 'cust1', status: 'COMPLETED', quotedPriceCents: 10000, paymentStatus: 'UNPAID',
  amountPaidCents: null, giftCardAppliedCents: null, depositRequiredCents: null, depositPaidAt: null, paymentNote: null,
  customer: { email: 'c@x.nl', firstName: 'Anna', lastName: 'de Vries' }, service: { name: 'Clean' }, ...over,
});
const rows = () => transactions.record.mock.calls.map(([row, opts]) => ({ row, opts }));

beforeEach(() => {
  jest.clearAllMocks();
  transactions.record.mockResolvedValue(true);
  prisma.booking.update.mockImplementation(({ data }) => Promise.resolve({ ...booking(), ...data }));
});

describe('markPaymentReceived', () => {
  test('logs the amount received, by the method used, with the reference', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking());
    await service.markPaymentReceived('biz1', 'bk1', 'u1', { method: 'BANK_TRANSFER', amountCents: 4000, reference: 'NL91-INV-7', note: 'part' });
    const [{ row }] = rows();
    expect(row).toMatchObject({ type: 'BOOKING_PAYMENT', direction: 'IN', method: 'BANK_TRANSFER', amountCents: 4000, businessId: 'biz1', bookingId: 'bk1', reference: 'NL91-INV-7' });
  });

  test('with no amount given, the balance that was due is what is logged', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ depositRequiredCents: 2000, depositPaidAt: new Date() }));
    await service.markPaymentReceived('biz1', 'bk1', 'u1', { method: 'CASH' });
    expect(rows()[0].row.amountCents).toBe(8000); // 10000 quote - 2000 deposit already received
  });

  test('a booking that is already fully paid logs nothing new', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ paymentStatus: 'PAID', amountPaidCents: 10000 }));
    await service.markPaymentReceived('biz1', 'bk1', 'u1', { method: 'CASH' }).catch(() => {});
    expect(transactions.record).not.toHaveBeenCalled();
  });
});

describe('updatePaymentStatus (the manual status switch)', () => {
  test('UNPAID -> PAID logs the amount that was due, as one revivable row', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ paymentStatus: 'UNPAID' }));
    await service.updatePaymentStatus('biz1', 'bk1', 'u1', { paymentStatus: 'PAID' });
    const [{ row, opts }] = rows();
    expect(row).toMatchObject({ type: 'BOOKING_PAYMENT', direction: 'IN', method: 'OTHER', amountCents: 10000, dedupeKey: 'jobpay:flip:bk1' });
    expect(opts).toEqual({ updateOnConflict: true });
  });

  test('PARTIAL -> PAID logs only the remaining balance, not the whole price again', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ paymentStatus: 'PARTIAL', amountPaidCents: 4000 }));
    await service.updatePaymentStatus('biz1', 'bk1', 'u1', { paymentStatus: 'PAID' });
    expect(rows()[0].row.amountCents).toBe(6000);
  });

  test('re-saving a booking that is already PAID logs nothing (no double counting)', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ paymentStatus: 'PAID', amountPaidCents: 10000 }));
    await service.updatePaymentStatus('biz1', 'bk1', 'u1', { paymentStatus: 'PAID' });
    expect(transactions.record).not.toHaveBeenCalled();
  });

  test('setting UNPAID reverses the hand-recorded payments, because the booking forgets them too', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ paymentStatus: 'PAID', amountPaidCents: 10000 }));
    await service.updatePaymentStatus('biz1', 'bk1', 'u1', { paymentStatus: 'UNPAID' });
    expect(transactions.reverseManualPayments).toHaveBeenCalledWith('bk1');
    expect(transactions.record).not.toHaveBeenCalled();
  });

  test('PARTIAL and REFUNDED switches do not touch the log', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ paymentStatus: 'PAID', amountPaidCents: 10000 }));
    await service.updatePaymentStatus('biz1', 'bk1', 'u1', { paymentStatus: 'PARTIAL' });
    await service.updatePaymentStatus('biz1', 'bk1', 'u1', { paymentStatus: 'REFUNDED' });
    expect(transactions.record).not.toHaveBeenCalled();
    expect(transactions.reverseManualPayments).not.toHaveBeenCalled();
  });
});

describe('cancelBooking refunds', () => {
  const paid = booking({ status: 'CONFIRMED', paymentStatus: 'PAID', amountPaidCents: 10000, stripePaymentIntentId: 'pi_job', depositRequiredCents: 2000, depositPaidAt: new Date(), stripeDepositPaymentIntentId: 'pi_dep' });

  test('each Stripe refund is logged separately (a deposit and a job payment are different payments), with the cancellation fee noted', async () => {
    prisma.booking.findFirst.mockResolvedValue(paid);
    evaluateCancellation.mockResolvedValue({
      feeCents: 1000, refundCents: 11000, alreadyPaidCents: 12000, manualRefundCents: 0,
      refundPlan: [{ paymentIntentId: 'pi_job', amountCents: 9000 }, { paymentIntentId: 'pi_dep', amountCents: 2000 }],
    });
    createRefund.mockResolvedValueOnce({ id: 're_job' }).mockResolvedValueOnce({ id: 're_dep' });
    await service.cancelBooking('biz1', 'bk1', 'u1', 'conflict');
    const got = rows().map((r) => r.row);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ type: 'REFUND', direction: 'OUT', amountCents: 9000, stripeRefundId: 're_job', stripePaymentIntentId: 'pi_job', dedupeKey: 'refund:re_job' });
    expect(got[1]).toMatchObject({ amountCents: 2000, stripeRefundId: 're_dep', dedupeKey: 'refund:re_dep' });
    expect(got[0].metadata).toMatchObject({ reason: 'cancellation', cancellationFeeCents: 1000 });
  });

  test('a refund Stripe refused is NOT logged as money returned', async () => {
    prisma.booking.findFirst.mockResolvedValue(paid);
    evaluateCancellation.mockResolvedValue({ feeCents: 0, refundCents: 9000, alreadyPaidCents: 9000, manualRefundCents: 0, refundPlan: [{ paymentIntentId: 'pi_job', amountCents: 9000 }] });
    createRefund.mockRejectedValue(new Error('card closed'));
    await service.cancelBooking('biz1', 'bk1', 'u1', 'conflict');
    expect(transactions.record).not.toHaveBeenCalled();
  });

  test('a cancellation with nothing to refund logs nothing', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ status: 'CONFIRMED' }));
    evaluateCancellation.mockResolvedValue({ feeCents: 0, refundCents: 0, alreadyPaidCents: 0, manualRefundCents: 0, refundPlan: [] });
    await service.cancelBooking('biz1', 'bk1', 'u1', 'conflict');
    expect(transactions.record).not.toHaveBeenCalled();
  });
});
