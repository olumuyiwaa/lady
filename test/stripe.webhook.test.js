jest.mock('../src/config/database.js', () => ({
  businessSubscription: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() },
  subscriptionPlan: { findUnique: jest.fn() },
  platformInvoice: { upsert: jest.fn() },
  business: { findFirst: jest.fn(), update: jest.fn() },
  user: { updateMany: jest.fn() },
  booking: { findUnique: jest.fn(), update: jest.fn() },
  auditLog: { create: jest.fn() },
}));
jest.mock('../src/lib/stripeClient', () => ({
  retrieveEvent: jest.fn(),
  retrieveSubscription: jest.fn(),
}));

const mockPrisma = require('../src/config/database.js');
const stripeClient = require('../src/lib/stripeClient');
const { handle, mapStripeStatus } = require('../src/modules/webhooks/stripe.controller');

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
}
const req = { rawBody: Buffer.from('{}'), headers: { 'stripe-signature': 'sig' } };

describe('stripe webhook', () => {
  beforeEach(() => jest.clearAllMocks());

  test('maps Stripe statuses to the enum and ignores states we must not write', () => {
    expect(mapStripeStatus('trialing')).toBe('TRIALING');
    expect(mapStripeStatus('active')).toBe('ACTIVE');
    expect(mapStripeStatus('past_due')).toBe('PAST_DUE');
    expect(mapStripeStatus('unpaid')).toBe('PAST_DUE');
    expect(mapStripeStatus('canceled')).toBe('CANCELED');
    expect(mapStripeStatus('incomplete')).toBeNull();
    expect(mapStripeStatus('paused')).toBeNull();
  });

  test('answers 503 (not 200) when no signing secret is configured', async () => {
    stripeClient.retrieveEvent.mockResolvedValue(null);
    const res = makeRes();
    await handle(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  test('an invoice without a subscription never touches subscription rows', async () => {
    stripeClient.retrieveEvent.mockResolvedValue({
      id: 'evt1', type: 'invoice.payment_succeeded', data: { object: { id: 'in_1', subscription: null, lines: { data: [] } } },
    });
    const res = makeRes();
    await handle(req, res);
    expect(mockPrisma.businessSubscription.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.businessSubscription.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  test('a subscription.updated with status incomplete does not write an invalid status', async () => {
    mockPrisma.subscriptionPlan.findUnique.mockResolvedValue(null);
    stripeClient.retrieveEvent.mockResolvedValue({
      id: 'evt2', type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'incomplete', current_period_end: 1800000000, items: { data: [] } } },
    });
    const res = makeRes();
    await handle(req, res);
    const call = mockPrisma.businessSubscription.updateMany.mock.calls[0][0];
    expect(call.data.status).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  test('a handler failure answers 500 so Stripe retries the event', async () => {
    mockPrisma.booking.findUnique.mockRejectedValue(new Error('db down'));
    stripeClient.retrieveEvent.mockResolvedValue({
      id: 'evt3', type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', payment_status: 'paid', metadata: { purpose: 'job_payment', bookingId: 'bk1' } } },
    });
    const res = makeRes();
    await handle(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  test('an unpaid (async) checkout session does not mark the booking paid', async () => {
    stripeClient.retrieveEvent.mockResolvedValue({
      id: 'evt4', type: 'checkout.session.completed',
      data: { object: { id: 'cs_2', payment_status: 'unpaid', metadata: { purpose: 'job_payment', bookingId: 'bk1' } } },
    });
    const res = makeRes();
    await handle(req, res);
    expect(mockPrisma.booking.update).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  test('subscription checkout completion upserts the row from Stripe data, not client input', async () => {
    stripeClient.retrieveSubscription.mockResolvedValue({ id: 'sub_9', status: 'trialing', trial_end: 1800000000, current_period_end: 1800000000 });
    stripeClient.retrieveEvent.mockResolvedValue({
      id: 'evt5', type: 'checkout.session.completed',
      data: { object: { id: 'cs_3', mode: 'subscription', customer: 'cus_1', subscription: 'sub_9', metadata: { businessId: 'biz1', planId: 'plan1' } } },
    });
    const res = makeRes();
    await handle(req, res);
    const arg = mockPrisma.businessSubscription.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ businessId: 'biz1' });
    expect(arg.create).toMatchObject({ stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_9', status: 'TRIALING' });
  });
});
