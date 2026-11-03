jest.mock('../src/config/database.js', () => ({ business: { update: jest.fn() } }));
const mockStripe = {
  refunds: { create: jest.fn().mockResolvedValue({ id: 're_1' }) },
  checkout: { sessions: { create: jest.fn().mockResolvedValue({ id: 'cs_1', url: 'u' }) } },
  accounts: { create: jest.fn().mockResolvedValue({ id: 'acct_1' }) },
  accountLinks: { create: jest.fn().mockResolvedValue({ url: 'l' }) },
  transfers: { create: jest.fn().mockResolvedValue({ id: 'tr_1' }) },
  webhooks: { constructEvent: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
const client = require('../src/lib/stripeClient');

describe('stripeClient payments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CHECKOUT_PAYMENT_METHODS;
    delete process.env.DEFAULT_CURRENCY;
    delete process.env.PLATFORM_COUNTRY;
    delete process.env.PLATFORM_APPLICATION_FEE_BPS;
    delete process.env.STRIPE_WEBHOOK_SECRETS;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  test('refunds for direct charges are created on the business account and do not reverse a transfer', async () => {
    await client.createRefund({ paymentIntentId: 'pi_1', amountCents: 500, connectedAccountId: 'acct_biz', idempotencyKey: 'k1' });
    const [params, opts] = mockStripe.refunds.create.mock.calls[0];
    expect(params).toMatchObject({ payment_intent: 'pi_1', amount: 500 });
    expect(params.reverse_transfer).toBeUndefined();
    expect(opts).toEqual({ stripeAccount: 'acct_biz', idempotencyKey: 'k1' });
  });

  test("Lady Greener's own-account marker sends no stripeAccount header and never reverses a transfer", async () => {
    await client.createRefund({ paymentIntentId: 'pi_1', amountCents: 500, connectedAccountId: client.DIRECT_ACCOUNT, idempotencyKey: 'k2' });
    const [params, opts] = mockStripe.refunds.create.mock.calls[0];
    expect(params.reverse_transfer).toBeUndefined();
    expect(opts).toEqual({ idempotencyKey: 'k2' });
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: client.DIRECT_ACCOUNT, amountCents: 5000, currency: 'eur' });
    expect(mockStripe.checkout.sessions.create.mock.calls[0][1]).toEqual({});
  });

  test('legacy refunds without a connected account still reverse the transfer', async () => {
    await client.createRefund({ paymentIntentId: 'pi_1', amountCents: 500 });
    expect(mockStripe.refunds.create.mock.calls[0][0]).toMatchObject({ reverse_transfer: true });
  });

  test('job payments are direct charges: created on the connected account, no transfer_data', async () => {
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: 'acct_biz', amountCents: 5000, currency: 'eur' });
    const [params, opts] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(opts).toEqual({ stripeAccount: 'acct_biz' });
    // 0% fee: no application_fee_amount. setup_future_usage is sent so the card can be reused for recurring jobs.
    expect(params.payment_intent_data).toEqual({ setup_future_usage: 'off_session' });
    expect(JSON.stringify(params)).not.toContain('transfer_data');
    expect(params.metadata).toMatchObject({ bookingId: 'b', purpose: 'job_payment' });
  });

  test('an application fee is only sent when configured', async () => {
    process.env.PLATFORM_APPLICATION_FEE_BPS = '150';
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: 'acct_biz', amountCents: 10000 });
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].payment_intent_data).toEqual({ setup_future_usage: 'off_session', application_fee_amount: 150 });
  });

  test('payment methods are dynamic by default so iDEAL follows the account settings', async () => {
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: 'acct', amountCents: 5000, currency: 'eur' });
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].payment_method_types).toBeUndefined();
  });

  test('a forced list still offers iDEAL for EUR and drops EUR-only methods otherwise', async () => {
    process.env.CHECKOUT_PAYMENT_METHODS = 'card,ideal';
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: 'acct', amountCents: 5000, currency: 'eur' });
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: 'acct', amountCents: 5000, currency: 'usd' });
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].payment_method_types).toEqual(['card', 'ideal']);
    expect(mockStripe.checkout.sessions.create.mock.calls[1][0].payment_method_types).toEqual(['card']);
  });

  test('deposit sessions can expire so an unpaid deposit releases its slot', async () => {
    const before = Math.floor(Date.now() / 1000);
    await client.createAncillaryCheckoutSession({ purpose: 'deposit', bookingId: 'b', businessId: 'x', connectedAccountId: 'acct', amountCents: 5000, expiresInMinutes: 60 });
    const at = mockStripe.checkout.sessions.create.mock.calls[0][0].expires_at;
    expect(at).toBeGreaterThanOrEqual(before + 3600);
    expect(at).toBeLessThanOrEqual(before + 3602);
  });

  test('expireCheckoutSession targets the connected account and never throws', async () => {
    mockStripe.checkout.sessions.expire = jest.fn().mockRejectedValue(new Error('already expired'));
    await expect(client.expireCheckoutSession('cs_1', 'acct_biz')).resolves.toBeNull();
    expect(mockStripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_1', {}, { stripeAccount: 'acct_biz' });
    await expect(client.expireCheckoutSession(null, 'acct_biz')).resolves.toBeNull();
  });

  test('webhook accepts an event that verifies against ANY configured secret (platform + Connect endpoints)', async () => {
    process.env.STRIPE_WEBHOOK_SECRETS = 'whsec_account, whsec_connect';
    mockStripe.webhooks.constructEvent.mockImplementation((body, sig, secret) => {
      if (secret === 'whsec_connect') return { id: 'evt_1' };
      throw new Error('bad sig');
    });
    await expect(client.retrieveEvent(Buffer.from('{}'), 'sig')).resolves.toEqual({ id: 'evt_1' });
    expect(mockStripe.webhooks.constructEvent).toHaveBeenCalledTimes(2);
  });

  test('webhook rejects when no secret matches, and returns null when none are configured', async () => {
    await expect(client.retrieveEvent(Buffer.from('{}'), 'sig')).resolves.toBeNull();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_only';
    mockStripe.webhooks.constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    await expect(client.retrieveEvent(Buffer.from('{}'), 'sig')).rejects.toThrow('bad sig');
  });

  test('the default currency is EUR and is configurable', async () => {
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: 'acct', amountCents: 5000 });
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].line_items[0].price_data.currency).toBe('eur');
    process.env.DEFAULT_CURRENCY = 'gbp';
    await client.createBookingCheckoutSession({ bookingId: 'b', businessId: 'x', connectedAccountId: 'acct', amountCents: 5000 });
    expect(mockStripe.checkout.sessions.create.mock.calls[1][0].line_items[0].price_data.currency).toBe('gbp');
  });

  test('connect onboarding does not force business_type company', async () => {
    await client.createConnectAccountAndLink({ id: 'b1', name: 'N' }, { refreshUrl: 'r', returnUrl: 'x' });
    const arg = mockStripe.accounts.create.mock.calls[0][0];
    expect(arg.business_type).toBeUndefined();
    expect(arg.type).toBe('express');
  });

  test('payout transfers carry an idempotency key so a retry cannot pay twice', async () => {
    await client.payCleanerTransfer({ businessConnectedAccountId: 'a', cleanerConnectedAccountId: 'c', amountCents: 100, payoutId: 'po1' });
    expect(mockStripe.transfers.create.mock.calls[0][1]).toMatchObject({ stripeAccount: 'a', idempotencyKey: 'payout_po1' });
  });
});
