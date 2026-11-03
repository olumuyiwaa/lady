jest.mock('../src/config/database.js', () => ({
  business: { findUnique: jest.fn() },
  customer: { findUnique: jest.fn() },
  booking: { update: jest.fn() },
}));
jest.mock('../src/lib/pricing.js', () => ({
  computeDepositCents: jest.fn(),
  calculateQuote: jest.fn(),
}));
jest.mock('../src/lib/stripeClient', () => ({
  createAncillaryCheckoutSession: jest.fn(),
}));

const mockPrisma = require('../src/config/database.js');
const pricing = require('../src/lib/pricing.js');
const { createAncillaryCheckoutSession } = require('../src/lib/stripeClient');
const { maybeCreateDepositSession } = require('../src/modules/widget/widget.service');

describe('widget.service.maybeCreateDepositSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const booking = { id: 'bk1', customerId: 'cust1', quotedPriceCents: 20000 };

  test('returns null when the business has no deposit policy configured', async () => {
    pricing.computeDepositCents.mockResolvedValue(0);
    const result = await maybeCreateDepositSession('biz1', booking);
    expect(result).toBeNull();
    expect(mockPrisma.business.findUnique).not.toHaveBeenCalled();
  });

  test('returns null when the business has not finished Stripe Connect onboarding', async () => {
    pricing.computeDepositCents.mockResolvedValue(5000);
    mockPrisma.business.findUnique.mockResolvedValue({ stripeChargesEnabled: false, stripeConnectedAccountId: null });
    const result = await maybeCreateDepositSession('biz1', booking);
    expect(result).toBeNull();
    expect(createAncillaryCheckoutSession).not.toHaveBeenCalled();
  });

  test('returns null when the business chose offline-only, even though Stripe is chargeable', async () => {
    // A business can have Stripe connected (e.g. for cleaner payouts) while
    // still explicitly telling customers to pay offline. Ignoring that and
    // creating an online session anyway would redirect the customer to
    // Stripe Checkout against the business's own stated preference.
    pricing.computeDepositCents.mockResolvedValue(5000);
    mockPrisma.business.findUnique.mockResolvedValue({
      stripeChargesEnabled: true,
      stripeConnectedAccountId: 'acct_123',
      preferredPaymentCollection: 'MANUAL_OFFLINE',
    });
    const result = await maybeCreateDepositSession('biz1', booking);
    expect(result).toBeNull();
    expect(createAncillaryCheckoutSession).not.toHaveBeenCalled();
  });

  test('creates a deposit checkout session and records it on the booking', async () => {
    pricing.computeDepositCents.mockResolvedValue(5000);
    mockPrisma.business.findUnique.mockResolvedValue({
      stripeChargesEnabled: true,
      stripeConnectedAccountId: 'acct_123',
    });
    mockPrisma.customer.findUnique.mockResolvedValue({ email: 'a@b.com' });
    createAncillaryCheckoutSession.mockResolvedValue({ id: 'cs_deposit_1', url: 'https://stripe.test/cs_deposit_1' });

    const result = await maybeCreateDepositSession('biz1', booking);

    expect(createAncillaryCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'deposit',
        bookingId: 'bk1',
        amountCents: 5000,
        connectedAccountId: 'acct_123',
        customerEmail: 'a@b.com',
      })
    );
    expect(mockPrisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'bk1' },
      data: { depositRequiredCents: 5000, stripeDepositSessionId: 'cs_deposit_1' },
    });
    expect(result).toEqual({ url: 'https://stripe.test/cs_deposit_1', sessionId: 'cs_deposit_1', depositRequiredCents: 5000 });
  });

  test('returns null when the computed deposit is below Stripe\'s minimum chargeable amount', async () => {
    pricing.computeDepositCents.mockResolvedValue(20); // below the 50-cent floor
    const result = await maybeCreateDepositSession('biz1', booking);
    expect(result).toBeNull();
    expect(mockPrisma.business.findUnique).not.toHaveBeenCalled();
  });
});
