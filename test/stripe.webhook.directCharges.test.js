jest.mock('../src/config/database.js', () => ({
  booking: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  business: { findUnique: jest.fn(), updateMany: jest.fn() },
  cleanerEarning: { updateMany: jest.fn() },
}));
jest.mock('../src/lib/stripeClient', () => ({ retrieveEvent: jest.fn(), retrieveSubscription: jest.fn() }));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/modules/bookings/bookings.service', () => ({ cancelBooking: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({ notifyMembers: jest.fn() }));

const prisma = require('../src/config/database.js');
const stripeClient = require('../src/lib/stripeClient');
const { audit } = require('../src/utils/audit');
const bookingsService = require('../src/modules/bookings/bookings.service');
const notifications = require('../src/modules/notifications/notifications.service');
const { handle } = require('../src/modules/webhooks/stripe.controller');

const res = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); r.send = jest.fn().mockReturnValue(r); return r; };
const req = { rawBody: Buffer.from('{}'), headers: { 'stripe-signature': 's' } };
const evt = (type, object, account) => ({ id: 'evt_1', type, account, data: { object } });

beforeEach(() => {
  jest.clearAllMocks();
  prisma.business.findUnique.mockResolvedValue({ stripeConnectedAccountId: 'acct_A' });
});

describe('direct-charge payment events', () => {
  const paidSession = { id: 'cs_1', mode: 'payment', payment_status: 'paid', amount_total: 5000, currency: 'eur', payment_intent: 'pi_1', metadata: { purpose: 'job_payment', bookingId: 'bk1', businessId: 'bizA' } };

  test('marks the booking paid when the event comes from the booking business account', async () => {
    prisma.booking.findUnique.mockResolvedValue({ id: 'bk1', businessId: 'bizA', paymentStatus: 'UNPAID', amountPaidCents: 0 });
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.completed', paidSession, 'acct_A'));
    const r = res();
    await handle(req, r);
    expect(prisma.booking.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ paymentStatus: 'PAID', stripePaymentIntentId: 'pi_1' }) }));
    expect(r.json).toHaveBeenCalledWith({ received: true });
  });

  test("ignores an event from ANOTHER tenant's account that carries this booking's id in metadata", async () => {
    prisma.booking.findUnique.mockResolvedValue({ id: 'bk1', businessId: 'bizA', paymentStatus: 'UNPAID' });
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.completed', paidSession, 'acct_EVIL'));
    await handle(req, res());
    expect(prisma.booking.update).not.toHaveBeenCalled();
  });

  test('platform-level events without event.account still work (legacy destination charges)', async () => {
    prisma.booking.findUnique.mockResolvedValue({ id: 'bk1', businessId: 'bizA', paymentStatus: 'UNPAID', amountPaidCents: 0 });
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.completed', paidSession, undefined));
    await handle(req, res());
    expect(prisma.booking.update).toHaveBeenCalled();
  });
});

describe('checkout.session.expired (deposit)', () => {
  const expired = { id: 'cs_dep', metadata: { purpose: 'deposit', bookingId: 'bk1' } };
  const booking = { id: 'bk1', businessId: 'bizA', status: 'REQUESTED', depositPaidAt: null, stripeDepositSessionId: 'cs_dep' };

  test('cancels the still-REQUESTED booking with the fee waived, releasing its slot', async () => {
    prisma.booking.findUnique.mockResolvedValue(booking);
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.expired', expired, 'acct_A'));
    const r = res();
    await handle(req, r);
    expect(bookingsService.cancelBooking).toHaveBeenCalledWith('bizA', 'bk1', null, 'Deposit was not paid in time', { waiveFee: true });
    expect(r.json).toHaveBeenCalledWith({ received: true });
  });

  test.each([
    ['already paid', { depositPaidAt: new Date() }],
    ['already confirmed by staff', { status: 'CONFIRMED' }],
    ['a newer session replaced it', { stripeDepositSessionId: 'cs_newer' }],
  ])('does nothing when the booking is %s', async (_n, patch) => {
    prisma.booking.findUnique.mockResolvedValue({ ...booking, ...patch });
    stripeClient.retrieveEvent.mockResolvedValue(evt('checkout.session.expired', expired, 'acct_A'));
    await handle(req, res());
    expect(bookingsService.cancelBooking).not.toHaveBeenCalled();
  });
});

describe('disputes', () => {
  const dispute = { id: 'dp_1', payment_intent: 'pi_1', amount: 5000, currency: 'eur', reason: 'fraudulent', status: 'needs_response', evidence_details: { due_by: 1900000000 } };

  test('opening a dispute holds unpaid cleaner earnings, audits, and notifies the business', async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: 'bk1', businessId: 'bizA' });
    stripeClient.retrieveEvent.mockResolvedValue(evt('charge.dispute.created', dispute, 'acct_A'));
    await handle(req, res());
    expect(prisma.cleanerEarning.updateMany).toHaveBeenCalledWith({ where: { bookingId: 'bk1', status: 'PENDING' }, data: { status: 'VOIDED' } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_DISPUTE_OPENED', entityId: 'bk1' }));
    expect(notifications.notifyMembers).toHaveBeenCalledWith('bizA', 'PAYMENT_DISPUTE_OPENED', expect.any(String), expect.stringContaining('bk1'));
  });

  test('winning a dispute releases the held earnings; losing keeps them voided', async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: 'bk1', businessId: 'bizA' });
    stripeClient.retrieveEvent.mockResolvedValue(evt('charge.dispute.closed', { ...dispute, status: 'won' }, 'acct_A'));
    await handle(req, res());
    expect(prisma.cleanerEarning.updateMany).toHaveBeenCalledWith({ where: { bookingId: 'bk1', status: 'VOIDED' }, data: { status: 'PENDING' } });

    jest.clearAllMocks();
    prisma.business.findUnique.mockResolvedValue({ stripeConnectedAccountId: 'acct_A' });
    prisma.booking.findFirst.mockResolvedValue({ id: 'bk1', businessId: 'bizA' });
    stripeClient.retrieveEvent.mockResolvedValue(evt('charge.dispute.closed', { ...dispute, status: 'lost' }, 'acct_A'));
    await handle(req, res());
    expect(prisma.cleanerEarning.updateMany).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_DISPUTE_CLOSED' }));
  });

  test('a dispute for an unknown payment intent is ignored', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);
    stripeClient.retrieveEvent.mockResolvedValue(evt('charge.dispute.created', dispute, 'acct_A'));
    const r = res();
    await handle(req, r);
    expect(audit).not.toHaveBeenCalled();
    expect(r.json).toHaveBeenCalledWith({ received: true });
  });
});

test('deauthorizing the app switches off charges for that business', async () => {
  stripeClient.retrieveEvent.mockResolvedValue(evt('account.application.deauthorized', { id: 'ca_1' }, 'acct_A'));
  await handle(req, res());
  expect(prisma.business.updateMany).toHaveBeenCalledWith({ where: { stripeConnectedAccountId: 'acct_A' }, data: { stripeChargesEnabled: false, stripePayoutsEnabled: false } });
});
