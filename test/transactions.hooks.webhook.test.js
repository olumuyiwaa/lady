/**
 * Every money event the Stripe webhook handles must land on the transaction
 * log, exactly once, with the right type/direction/amount - and a failure to
 * write the log must never fail the webhook (Stripe would redeliver it).
 */
jest.mock('../src/config/database.js', () => ({
  booking: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  business: { findUnique: jest.fn(), updateMany: jest.fn() },
  cleanerEarning: { updateMany: jest.fn() },
}));
jest.mock('../src/lib/stripeClient', () => ({ retrieveEvent: jest.fn(), createRefund: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/modules/bookings/bookings.service', () => ({ cancelBooking: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({ notifyMembers: jest.fn() }));
jest.mock('../src/modules/transactions/transactions.service', () => ({ record: jest.fn() }));

const prisma = require('../src/config/database.js');
const stripeClient = require('../src/lib/stripeClient');
const transactions = require('../src/modules/transactions/transactions.service');
const { handle } = require('../src/modules/webhooks/stripe.controller');

const res = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); r.send = jest.fn().mockReturnValue(r); return r; };
const req = { rawBody: Buffer.from('{}'), headers: { 'stripe-signature': 's' } };
const evt = (type, object, account = 'acct_A') => ({ id: 'evt_1', type, account, data: { object } });
const deliver = async (type, object, account) => { stripeClient.retrieveEvent.mockResolvedValue(evt(type, object, account)); const r = res(); await handle(req, r); return r; };
const recorded = () => transactions.record.mock.calls.map(([row, opts]) => ({ row, opts }));

const bk = (over = {}) => ({ id: 'bk1', businessId: 'bizA', customerId: 'cust1', paymentStatus: 'UNPAID', amountPaidCents: 0, depositPaidAt: null, tipPaidAt: null, depositRequiredCents: 2000, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.business.findUnique.mockResolvedValue({ stripeConnectedAccountId: 'acct_A' });
  prisma.booking.update.mockResolvedValue({});
  transactions.record.mockResolvedValue(true);
});

describe('customer payments', () => {
  test('a paid job link is logged as BOOKING_PAYMENT, money IN, keyed by the checkout session', async () => {
    prisma.booking.findUnique.mockResolvedValue(bk());
    await deliver('checkout.session.completed', { id: 'cs_job', mode: 'payment', payment_status: 'paid', amount_total: 8000, currency: 'eur', payment_intent: 'pi_job', metadata: { purpose: 'job_payment', bookingId: 'bk1' } });
    const [{ row }] = recorded();
    expect(row).toMatchObject({ type: 'BOOKING_PAYMENT', direction: 'IN', method: 'STRIPE', amountCents: 8000, currency: 'EUR', businessId: 'bizA', bookingId: 'bk1', stripePaymentIntentId: 'pi_job', dedupeKey: 'jobpay:stripe:cs_job' });
  });

  test('a paid deposit is logged as DEPOSIT for the amount actually charged', async () => {
    prisma.booking.findUnique.mockResolvedValue(bk());
    await deliver('checkout.session.completed', { id: 'cs_dep', mode: 'payment', payment_status: 'paid', amount_total: 2500, currency: 'eur', payment_intent: 'pi_dep', metadata: { purpose: 'deposit', bookingId: 'bk1' } });
    expect(recorded()[0].row).toMatchObject({ type: 'DEPOSIT', direction: 'IN', amountCents: 2500, dedupeKey: 'deposit:bk1' });
  });

  test('a paid tip is logged as TIP', async () => {
    prisma.booking.findUnique.mockResolvedValue(bk());
    await deliver('checkout.session.completed', { id: 'cs_tip', mode: 'payment', payment_status: 'paid', amount_total: 500, currency: 'eur', payment_intent: 'pi_tip', metadata: { purpose: 'tip', bookingId: 'bk1' } });
    expect(recorded()[0].row).toMatchObject({ type: 'TIP', direction: 'IN', amountCents: 500, dedupeKey: 'tip:bk1' });
  });

  test('a redelivered event (the booking update already applied) logs nothing a second time', async () => {
    prisma.booking.findUnique.mockResolvedValue(bk());
    prisma.booking.update.mockRejectedValue(Object.assign(new Error('not found'), { code: 'P2025' }));
    await deliver('checkout.session.completed', { id: 'cs_dep', mode: 'payment', payment_status: 'paid', amount_total: 2500, currency: 'eur', payment_intent: 'pi_dep', metadata: { purpose: 'deposit', bookingId: 'bk1' } });
    expect(transactions.record).not.toHaveBeenCalled();
  });

  test("an event from another tenant's Stripe account is ignored, and so is the log", async () => {
    prisma.booking.findUnique.mockResolvedValue(bk());
    await deliver('checkout.session.completed', { id: 'cs_job', mode: 'payment', payment_status: 'paid', amount_total: 8000, currency: 'eur', payment_intent: 'pi', metadata: { purpose: 'job_payment', bookingId: 'bk1' } }, 'acct_EVIL');
    expect(transactions.record).not.toHaveBeenCalled();
  });

  test('a payment still pending (SEPA) is not logged until it actually arrives', async () => {
    await deliver('checkout.session.completed', { id: 'cs_sepa', mode: 'payment', payment_status: 'unpaid', amount_total: 8000, metadata: { purpose: 'job_payment', bookingId: 'bk1' } });
    expect(transactions.record).not.toHaveBeenCalled();
  });

  test('a duplicate tip is logged as money IN and refunded OUT, so the log nets to zero', async () => {
    prisma.booking.findUnique.mockResolvedValue(bk({ tipPaidAt: new Date(), stripeTipSessionId: 'cs_first' }));
    stripeClient.createRefund.mockResolvedValue({ id: 're_dup' });
    await deliver('checkout.session.completed', { id: 'cs_second', mode: 'payment', payment_status: 'paid', amount_total: 700, currency: 'eur', payment_intent: 'pi_second', metadata: { purpose: 'tip', bookingId: 'bk1' } });
    const rows = recorded().map((r) => r.row);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: 'TIP', direction: 'IN', amountCents: 700, dedupeKey: 'tip:dup:cs_second' });
    expect(rows[1]).toMatchObject({ type: 'REFUND', direction: 'OUT', amountCents: 700, dedupeKey: 'refund:re_dup' });
    expect(rows[0].amountCents - rows[1].amountCents).toBe(0);
  });

  test('if the duplicate-tip refund FAILS, only the money in is logged (the business owes a manual refund)', async () => {
    prisma.booking.findUnique.mockResolvedValue(bk({ tipPaidAt: new Date(), stripeTipSessionId: 'cs_first' }));
    stripeClient.createRefund.mockRejectedValue(new Error('stripe down'));
    await deliver('checkout.session.completed', { id: 'cs_second', mode: 'payment', payment_status: 'paid', amount_total: 700, currency: 'eur', payment_intent: 'pi_second', metadata: { purpose: 'tip', bookingId: 'bk1' } });
    expect(recorded().map((r) => r.row.type)).toEqual(['TIP']);
  });
});

describe('refunds issued from the business Stripe dashboard (refund.created)', () => {
  const refund = { id: 're_dash', payment_intent: 'pi_job', amount: 3000, currency: 'eur', status: 'succeeded', reason: 'requested_by_customer', created: 1900000000 };

  test('are logged as REFUND, keyed by the Stripe refund id, and may update an existing row', async () => {
    prisma.booking.findFirst.mockResolvedValue(bk());
    await deliver('refund.created', refund);
    const [{ row, opts }] = recorded();
    expect(row).toMatchObject({ type: 'REFUND', direction: 'OUT', status: 'SUCCEEDED', amountCents: 3000, dedupeKey: 'refund:re_dash', occurredAt: new Date(1900000000 * 1000) });
    expect(opts).toEqual({ updateOnConflict: true });
  });

  test('a booking is found by any of its three payment intents', async () => {
    prisma.booking.findFirst.mockResolvedValue(bk());
    await deliver('refund.created', refund);
    expect(prisma.booking.findFirst.mock.calls[0][0].where.OR).toEqual([{ stripePaymentIntentId: 'pi_job' }, { stripeDepositPaymentIntentId: 'pi_job' }, { stripeTipPaymentIntentId: 'pi_job' }]);
  });

  test.each([['failed'], ['canceled']])('a %s refund is logged as FAILED, so it cannot inflate refunds', async (status) => {
    prisma.booking.findFirst.mockResolvedValue(bk());
    await deliver('refund.updated', { ...refund, status });
    expect(recorded()[0].row.status).toBe('FAILED');
  });

  test('a refund for a payment that is not one of ours is ignored', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);
    await deliver('refund.created', refund);
    expect(transactions.record).not.toHaveBeenCalled();
  });

  test("a refund event from another tenant's account is ignored", async () => {
    prisma.booking.findFirst.mockResolvedValue(bk());
    await deliver('refund.created', refund, 'acct_EVIL');
    expect(transactions.record).not.toHaveBeenCalled();
  });

  test('a zero-amount refund is ignored', async () => {
    prisma.booking.findFirst.mockResolvedValue(bk());
    await deliver('refund.created', { ...refund, amount: 0 });
    expect(transactions.record).not.toHaveBeenCalled();
  });
});

describe('disputes', () => {
  const dispute = { id: 'dp_1', payment_intent: 'pi_1', amount: 5000, currency: 'eur', reason: 'fraudulent', status: 'needs_response', evidence_details: { due_by: 1900000000 } };

  test('opening one logs money OUT as PENDING', async () => {
    prisma.booking.findFirst.mockResolvedValue(bk());
    await deliver('charge.dispute.created', dispute);
    expect(recorded()[0].row).toMatchObject({ type: 'DISPUTE', direction: 'OUT', status: 'PENDING', amountCents: 5000, dedupeKey: 'dispute:dp_1' });
    expect(recorded()[0].opts).toEqual({ updateOnConflict: true });
  });

  test.each([['lost', 'SUCCEEDED'], ['won', 'REVERSED']])('closing as %s settles the same row to %s', async (status, expected) => {
    prisma.booking.findFirst.mockResolvedValue(bk());
    await deliver('charge.dispute.closed', { ...dispute, status });
    expect(recorded()[0].row).toMatchObject({ status: expected, dedupeKey: 'dispute:dp_1' });
  });
});

describe('the log can never break the money flow', () => {
  test('when the log reports failure the webhook is still acknowledged (so Stripe does not redeliver)', async () => {
    prisma.booking.findUnique.mockResolvedValue(bk());
    transactions.record.mockResolvedValue(false);
    const r = await deliver('checkout.session.completed', { id: 'cs_dep', mode: 'payment', payment_status: 'paid', amount_total: 2500, currency: 'eur', payment_intent: 'pi', metadata: { purpose: 'deposit', bookingId: 'bk1' } });
    expect(r.json).toHaveBeenCalledWith({ received: true });
    expect(prisma.booking.update).toHaveBeenCalled(); // the booking was still updated
  });
});
