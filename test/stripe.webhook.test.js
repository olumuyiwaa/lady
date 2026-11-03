jest.mock('../src/config/database.js', () => ({
  business: { findFirst: jest.fn(), update: jest.fn() },
  user: { updateMany: jest.fn() },
  booking: { findUnique: jest.fn(), update: jest.fn() },
  auditLog: { create: jest.fn() },
}));
jest.mock('../src/lib/stripeClient', () => ({
  retrieveEvent: jest.fn(),
}));

const mockPrisma = require('../src/config/database.js');
const stripeClient = require('../src/lib/stripeClient');
const { handle } = require('../src/modules/webhooks/stripe.controller');

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

  test('answers 503 (not 200) when no signing secret is configured', async () => {
    stripeClient.retrieveEvent.mockResolvedValue(null);
    const res = makeRes();
    await handle(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
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
});
