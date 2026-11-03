// updateBusiness used to accept preferredPaymentCollection: 'ONLINE_CARD'
// unconditionally. Selected before Stripe was actually connected and
// chargeable, this left the storefront with no way to pay at all:
// maybeCreateDepositSession skips creating a session when Stripe isn't
// chargeable, and getStorefront's old canPayOffline derivation only turned
// on for MANUAL_OFFLINE/BOTH — so a booking could go through with no
// deposit session and no offline panel either. BOTH and MANUAL_OFFLINE are
// safe regardless of Stripe status (see widget.hardening.test.js's
// storefront fallback test for the belt-and-braces side of this fix) and
// must stay selectable any time.

jest.mock('../src/config/database.js', () => ({
  business: { findUnique: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
  service: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
}));
jest.mock('../src/config/storage', () => ({ getPublicUploadUrl: jest.fn(), getPublicUrl: jest.fn() }));
jest.mock('../src/lib/subscriptionAccess', () => ({ getEffectivePlan: jest.fn().mockResolvedValue(null), getAccess: jest.fn() }));

const prisma = require('../src/config/database.js');
const businesses = require('../src/modules/businesses/businesses.service');

beforeEach(() => {
  jest.clearAllMocks();
  prisma.business.update.mockImplementation(async ({ data }) => ({ id: 'b1', ...data }));
});

describe('preferredPaymentCollection = ONLINE_CARD requires Stripe to actually be chargeable', () => {
  test('rejected when Stripe has never been connected', async () => {
    prisma.business.findUnique.mockResolvedValue({
      id: 'b1', currency: 'eur', timezone: 'Europe/Amsterdam',
      stripeChargesEnabled: false, stripeConnectedAccountId: null,
    });
    await expect(
      businesses.updateBusiness('b1', { preferredPaymentCollection: 'ONLINE_CARD' })
    ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/Connect Stripe/) });
    expect(prisma.business.update).not.toHaveBeenCalled();
  });

  test('rejected when connected but onboarding is not finished (charges not yet enabled)', async () => {
    prisma.business.findUnique.mockResolvedValue({
      id: 'b1', currency: 'eur', timezone: 'Europe/Amsterdam',
      stripeChargesEnabled: false, stripeConnectedAccountId: 'acct_123',
    });
    await expect(
      businesses.updateBusiness('b1', { preferredPaymentCollection: 'ONLINE_CARD' })
    ).rejects.toMatchObject({ status: 422 });
  });

  test('allowed once Stripe is actually chargeable', async () => {
    prisma.business.findUnique.mockResolvedValue({
      id: 'b1', currency: 'eur', timezone: 'Europe/Amsterdam',
      stripeChargesEnabled: true, stripeConnectedAccountId: 'acct_123',
    });
    await businesses.updateBusiness('b1', { preferredPaymentCollection: 'ONLINE_CARD' });
    expect(prisma.business.update.mock.calls[0][0].data).toMatchObject({ preferredPaymentCollection: 'ONLINE_CARD' });
  });

  test.each(['BOTH', 'MANUAL_OFFLINE'])(
    '%s is always allowed, regardless of Stripe status',
    async (value) => {
      prisma.business.findUnique.mockResolvedValue({
        id: 'b1', currency: 'eur', timezone: 'Europe/Amsterdam',
        stripeChargesEnabled: false, stripeConnectedAccountId: null,
      });
      await businesses.updateBusiness('b1', { preferredPaymentCollection: value });
      expect(prisma.business.update.mock.calls[0][0].data).toMatchObject({ preferredPaymentCollection: value });
    }
  );

  test('a business already saved as ONLINE_CARD (e.g. Stripe disconnected afterward) can still update an unrelated field without being blocked', async () => {
    prisma.business.findUnique.mockResolvedValue({
      id: 'b1', currency: 'eur', timezone: 'Europe/Amsterdam',
      stripeChargesEnabled: false, stripeConnectedAccountId: null,
      preferredPaymentCollection: 'ONLINE_CARD',
    });
    // Re-sending the same (now-invalid-to-newly-choose) value while only
    // actually changing something else must not be rejected — only an
    // actual change to ONLINE_CARD is guarded.
    await businesses.updateBusiness('b1', {
      preferredPaymentCollection: 'ONLINE_CARD',
      offlinePaymentInstructions: 'Bank transfer to NL00...',
    });
    expect(prisma.business.update.mock.calls[0][0].data).toMatchObject({
      preferredPaymentCollection: 'ONLINE_CARD',
      offlinePaymentInstructions: 'Bank transfer to NL00...',
    });
  });
});
