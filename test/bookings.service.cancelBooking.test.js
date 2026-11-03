jest.mock('../src/config/database.js', () => {
  const db = {
    booking: { findFirst: jest.fn(), update: jest.fn() },
    giftCard: { findUnique: jest.fn(), update: jest.fn() },
    coupon: { updateMany: jest.fn() },
  };
  db.$transaction = jest.fn((fn) => fn(db));
  return db;
});
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({
  notifyBookingCancelled: jest.fn(),
}));
jest.mock('../src/lib/stripeClient', () => ({
  createBookingCheckoutSession: jest.fn(),
  createAncillaryCheckoutSession: jest.fn(),
  createRefund: jest.fn(),
  expireCheckoutSession: jest.fn(),
}));
jest.mock('../src/lib/cancellationPolicy', () => ({
  evaluateCancellation: jest.fn(),
}));

const mockPrisma = require('../src/config/database.js');
const { createRefund, expireCheckoutSession } = require('../src/lib/stripeClient');
const { evaluateCancellation } = require('../src/lib/cancellationPolicy');
const bookingsService = require('../src/modules/bookings/bookings.service');

describe('bookings.service.cancelBooking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.booking.update.mockImplementation(({ data }) => ({ ...existingBooking, ...data }));
  });

  const existingBooking = {
    id: 'bk1',
    status: 'CONFIRMED',
    quotedPriceCents: 10000,
    paymentStatus: 'PAID',
    amountPaidCents: 10000,
    stripePaymentIntentId: 'pi_job_123',
  };
  const plan = (items, manual = 0) => ({ refundPlan: items, manualRefundCents: manual });

  test('rejects cancelling an already-completed booking', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue({ ...existingBooking, status: 'COMPLETED' });
    await expect(bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'changed my mind')).rejects.toThrow(
      /already COMPLETED/
    );
    expect(createRefund).not.toHaveBeenCalled();
  });

  test('issues a partial refund when the policy owes one, and records it on the booking', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(existingBooking);
    evaluateCancellation.mockResolvedValue({
      feeCents: 5000,
      refundCents: 5000,
      alreadyPaidCents: 10000,
      ...plan([{ paymentIntentId: 'pi_job_123', amountCents: 5000 }]),
    });
    createRefund.mockResolvedValue({ id: 're_123' });

    const result = await bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'schedule conflict');

    expect(createRefund).toHaveBeenCalledWith({
      paymentIntentId: 'pi_job_123',
      amountCents: 5000,
      reason: 'requested_by_customer',
      connectedAccountId: undefined,
      idempotencyKey: 'cancel-refund:bk1:pi_job_123:5000',
    });
    expect(mockPrisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          cancellationFeeCents: 5000,
          refundedAmountCents: 5000,
          stripeRefundId: 're_123',
          paymentStatus: 'PARTIAL', // refund (5000) < total paid (10000)
        }),
      })
    );
    expect(result.status).toBe('CANCELLED');
  });

  test('deposit and job payment are refunded against their own PaymentIntents', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(existingBooking);
    evaluateCancellation.mockResolvedValue({
      feeCents: 0,
      refundCents: 12000,
      alreadyPaidCents: 12000,
      ...plan([
        { paymentIntentId: 'pi_job_123', amountCents: 10000 },
        { paymentIntentId: 'pi_dep_9', amountCents: 2000 },
      ]),
    });
    createRefund.mockResolvedValueOnce({ id: 're_a' }).mockResolvedValueOnce({ id: 're_b' });

    await bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'reason');

    expect(createRefund).toHaveBeenCalledTimes(2);
    expect(createRefund).toHaveBeenNthCalledWith(1, expect.objectContaining({ paymentIntentId: 'pi_job_123', amountCents: 10000 }));
    expect(createRefund).toHaveBeenNthCalledWith(2, expect.objectContaining({ paymentIntentId: 'pi_dep_9', amountCents: 2000 }));
    expect(mockPrisma.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refundedAmountCents: 12000, stripeRefundId: 're_a,re_b', paymentStatus: 'REFUNDED' }),
      })
    );
  });

  test('waiveFee keeps the customer whole: the policy fee is dropped but what they paid is refunded', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(existingBooking);
    evaluateCancellation.mockResolvedValue({
      feeCents: 0,
      refundCents: 10000,
      alreadyPaidCents: 10000,
      ...plan([{ paymentIntentId: 'pi_job_123', amountCents: 10000 }]),
    });
    createRefund.mockResolvedValue({ id: 're_w' });

    await bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'business error', { waiveFee: true });

    expect(evaluateCancellation).toHaveBeenCalledWith('biz1', existingBooking, { waiveFee: true });
    expect(createRefund).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 10000 }));
  });

  test('a failed Stripe refund still cancels the booking, records the shortfall, and no refund', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue(existingBooking);
    evaluateCancellation.mockResolvedValue({
      feeCents: 0,
      refundCents: 10000,
      alreadyPaidCents: 10000,
      ...plan([{ paymentIntentId: 'pi_job_123', amountCents: 10000 }]),
    });
    createRefund.mockRejectedValue(new Error('stripe is down'));

    const result = await bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'reason');

    expect(result.status).toBe('CANCELLED');
    const data = mockPrisma.booking.update.mock.calls[0][0].data;
    expect(data.refundedAmountCents).toBeUndefined();
    expect(data.paymentNote).toContain('refund_failed:10000');
  });

  test('money paid outside Stripe is flagged for the business to return by hand', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue({ ...existingBooking, stripePaymentIntentId: null });
    evaluateCancellation.mockResolvedValue({
      feeCents: 0,
      refundCents: 10000,
      alreadyPaidCents: 10000,
      ...plan([], 10000),
    });

    await bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'reason');

    expect(createRefund).not.toHaveBeenCalled();
    expect(mockPrisma.booking.update.mock.calls[0][0].data.paymentNote).toContain('refund_due_manual:10000');
  });

  test('cancelling gives the gift card value and the coupon redemption back', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue({ ...existingBooking, giftCardId: 'gc1', giftCardAppliedCents: 3000, couponId: 'cp1' });
    evaluateCancellation.mockResolvedValue({ feeCents: 0, refundCents: 0, alreadyPaidCents: 0, ...plan([]) });
    mockPrisma.giftCard.findUnique.mockResolvedValue({ id: 'gc1', initialValueCents: 5000, balanceCents: 1000 });

    await bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'reason');

    expect(mockPrisma.giftCard.update).toHaveBeenCalledWith({ where: { id: 'gc1' }, data: { balanceCents: 4000 } });
    expect(mockPrisma.coupon.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'cp1' }), data: { redeemedCount: { decrement: 1 } } })
    );
  });

  test('a restored gift card balance never exceeds its original value', async () => {
    mockPrisma.booking.findFirst.mockResolvedValue({ ...existingBooking, giftCardId: 'gc1', giftCardAppliedCents: 3000 });
    evaluateCancellation.mockResolvedValue({ feeCents: 0, refundCents: 0, alreadyPaidCents: 0, ...plan([]) });
    mockPrisma.giftCard.findUnique.mockResolvedValue({ id: 'gc1', initialValueCents: 5000, balanceCents: 4500 });
    await bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'reason');
    expect(mockPrisma.giftCard.update).toHaveBeenCalledWith({ where: { id: 'gc1' }, data: { balanceCents: 5000 } });
  });

  test('refunds go to the business connected account and unpaid payment links are expired', async () => {
    const booking = {
      ...existingBooking,
      paymentStatus: 'DEPOSIT_PAID',
      depositPaidAt: new Date(),
      stripeCheckoutSessionId: 'cs_open_job',
      stripeDepositSessionId: 'cs_paid_dep',
      business: { stripeConnectedAccountId: 'acct_biz' },
    };
    mockPrisma.booking.findFirst.mockResolvedValue(booking);
    evaluateCancellation.mockResolvedValue({ feeCents: 0, refundCents: 10000, alreadyPaidCents: 10000, ...plan([{ paymentIntentId: 'pi_job_123', amountCents: 10000 }]) });
    createRefund.mockResolvedValue({ id: 're_x' });

    await bookingsService.cancelBooking('biz1', 'bk1', 'user1', 'x');

    expect(createRefund).toHaveBeenCalledWith(expect.objectContaining({ connectedAccountId: 'acct_biz' }));
    // the unpaid job link is killed; the deposit session was already paid, so it is left alone
    expect(expireCheckoutSession).toHaveBeenCalledTimes(1);
    expect(expireCheckoutSession).toHaveBeenCalledWith('cs_open_job', 'acct_biz');
  });
});
