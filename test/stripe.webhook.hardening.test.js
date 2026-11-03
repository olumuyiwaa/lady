jest.mock('../src/config/database.js', () => ({
  booking: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  business: { findUnique: jest.fn(), updateMany: jest.fn() },
  cleanerEarning: { updateMany: jest.fn() },
}));
jest.mock('../src/lib/stripeClient', () => ({ retrieveEvent: jest.fn(), retrieveSubscription: jest.fn(), createRefund: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/modules/bookings/bookings.service', () => ({ cancelBooking: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({ notifyMembers: jest.fn() }));

const prisma = require('../src/config/database.js');
const stripeClient = require('../src/lib/stripeClient');
const { audit } = require('../src/utils/audit');
const { handle } = require('../src/modules/webhooks/stripe.controller');

const res = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); r.send = jest.fn().mockReturnValue(r); return r; };
const req = { rawBody: Buffer.from('{}'), headers: { 'stripe-signature': 's' } };
const evt = (type, object, account = 'acct_A') => ({ id: 'evt_1', type, account, data: { object } });
const notFound = () => Object.assign(new Error('Record to update not found'), { code: 'P2025' });

beforeEach(() => {
  jest.resetAllMocks();
  prisma.business.findUnique.mockResolvedValue({ stripeConnectedAccountId: 'acct_A' });
});

describe('concurrent webhook deliveries', () => {
  const paid = { id: 'cs_1', mode: 'payment', payment_status: 'paid', amount_total: 5000, currency: 'eur', payment_intent: 'pi_1', metadata: { purpose: 'job_payment', bookingId: 'bk1', businessId: 'bizA' } };
  const booking = { id: 'bk1', businessId: 'bizA', paymentStatus: 'UNPAID', amountPaidCents: 0 };

  test('the write is conditional and the amount is added by the database', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking);
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.completed', paid));
    await handle(req, res());
    const arg = prisma.booking.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'bk1', paymentStatus: { not: 'PAID' } });
    expect(arg.data.amountPaidCents).toEqual({ increment: 5000 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'BOOKING_PAYMENT_RECEIVED' }));
  });

  test('a delivery that loses the race records nothing and still acknowledges', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking);
    prisma.booking.update.mockRejectedValue(notFound());
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.completed', paid));
    const r = res();
    await handle(req, r);
    expect(audit).not.toHaveBeenCalled();
    expect(r.json).toHaveBeenCalledWith({ received: true });
  });

  test('other database errors are not swallowed', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking);
    prisma.booking.update.mockRejectedValue(new Error('connection lost'));
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.completed', paid));
    const r = res();
    await handle(req, r);
    expect(r.json).not.toHaveBeenCalledWith({ received: true });
  });
});

describe('duplicate tips', () => {
  const tipSession = (id) => ({ id, mode: 'payment', payment_status: 'paid', amount_total: 500, currency: 'eur', payment_intent: `pi_${id}`, metadata: { purpose: 'tip', bookingId: 'bk1', businessId: 'bizA' } });
  const tipped = { id: 'bk1', businessId: 'bizA', tipPaidAt: new Date(), stripeTipSessionId: 'cs_first' };

  test('a second paid tip session is refunded on the business account', async () => {
    prisma.booking.findUnique.mockResolvedValue(tipped);
    stripeClient.createRefund.mockResolvedValue({ id: 're_1' });
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.completed', tipSession('cs_second')));
    await handle(req, res());
    expect(stripeClient.createRefund).toHaveBeenCalledWith({ paymentIntentId: 'pi_cs_second', reason: 'duplicate', connectedAccountId: 'acct_A', idempotencyKey: 'dup-tip-cs_second' });
    expect(prisma.booking.update).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'BOOKING_TIP_DUPLICATE_REFUNDED' }));
  });

  test('a redelivery of the tip that WAS recorded is not mistaken for a duplicate', async () => {
    prisma.booking.findUnique.mockResolvedValue(tipped);
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.completed', tipSession('cs_first')));
    await handle(req, res());
    expect(stripeClient.createRefund).not.toHaveBeenCalled();
  });

  test('if the refund fails it is flagged for manual handling', async () => {
    prisma.booking.findUnique.mockResolvedValue(tipped);
    stripeClient.createRefund.mockRejectedValue(new Error('stripe down'));
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.completed', tipSession('cs_second')));
    const r = res();
    await handle(req, r);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'BOOKING_TIP_DUPLICATE_NEEDS_REFUND' }));
    expect(r.json).toHaveBeenCalledWith({ received: true });
  });

  test("another tenant's account cannot trigger a refund", async () => {
    prisma.booking.findUnique.mockResolvedValue(tipped);
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.completed', tipSession('cs_second'), 'acct_EVIL'));
    await handle(req, res());
    expect(stripeClient.createRefund).not.toHaveBeenCalled();
  });
});
