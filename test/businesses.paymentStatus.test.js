// Tod Cleaning Services charges on its own Stripe account, so there is no Stripe Connect
// onboarding any more: the dashboard only needs to know whether card payments
// are on (read-only) and the setup checklist no longer asks for Stripe.
jest.mock('../src/config/database.js', () => ({
  business: { findUnique: jest.fn() },
  service: { count: jest.fn() },
  businessHours: { count: jest.fn() },
  serviceArea: { count: jest.fn() },
}));
jest.mock('../src/config/storage', () => ({ getPublicUploadUrl: jest.fn(), getPublicUrl: jest.fn() }));
jest.mock('../src/lib/subscriptionAccess', () => ({ getEffectivePlan: jest.fn().mockResolvedValue(null), getAccess: jest.fn() }));

const prisma = require('../src/config/database.js');
const businesses = require('../src/modules/businesses/businesses.service');

beforeEach(() => jest.clearAllMocks());

describe('getPaymentStatus', () => {
  const row = (over = {}) => ({
    stripeConnectedAccountId: 'direct', stripeConnectOnboarded: true, stripeChargesEnabled: true,
    stripePayoutsEnabled: true, preferredPaymentCollection: 'BOTH', offlinePaymentInstructions: 'IBAN NL00',
    ...over,
  });

  test('card payments ready when the business charges on the platform account', async () => {
    prisma.business.findUnique.mockResolvedValue(row());
    const s = await businesses.getPaymentStatus('b1');
    expect(s).toMatchObject({ onlineCardReady: true, readyForPayments: true, canAcceptCardPayments: true, canAcceptOfflinePayments: true, offlinePaymentInstructions: 'IBAN NL00' });
    expect(s.message).not.toMatch(/Connect/);
  });

  test('not ready when charges are disabled, and offline-only is reported as such', async () => {
    prisma.business.findUnique.mockResolvedValue(row({ stripeChargesEnabled: false, preferredPaymentCollection: 'MANUAL_OFFLINE' }));
    const s = await businesses.getPaymentStatus('b1');
    expect(s).toMatchObject({ onlineCardReady: false, canAcceptCardPayments: false, canAcceptOfflinePayments: true });
    expect(s.message).not.toMatch(/Connect/);
  });

  test('unknown business is a 404', async () => {
    prisma.business.findUnique.mockResolvedValue(null);
    await expect(businesses.getPaymentStatus('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('getOnboardingStatus', () => {
  test('has no Stripe step; complete once services, hours and a service area exist', async () => {
    prisma.service.count.mockResolvedValue(2);
    prisma.businessHours.count.mockResolvedValue(7);
    prisma.serviceArea.count.mockResolvedValue(1);
    const s = await businesses.getOnboardingStatus('b1');
    expect(s.steps.map((x) => x.key)).toEqual(['services', 'hours', 'serviceAreas']);
    expect(s.isComplete).toBe(true);
  });

  test('incomplete when a required step is missing', async () => {
    prisma.service.count.mockResolvedValue(0);
    prisma.businessHours.count.mockResolvedValue(7);
    prisma.serviceArea.count.mockResolvedValue(1);
    const s = await businesses.getOnboardingStatus('b1');
    expect(s.isComplete).toBe(false);
    expect(s.nextIncompleteStep).toBe('services');
  });
});
