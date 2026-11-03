jest.mock('../src/config/database.js', () => {
  const db = {
    service: { findFirst: jest.fn(), findMany: jest.fn() },
    serviceArea: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
    business: { findUnique: jest.fn() },
    businessHours: { findMany: jest.fn() },
    businessPricing: { findUnique: jest.fn().mockResolvedValue(null) },
    bookingQuestion: { findMany: jest.fn().mockResolvedValue([]) },
    booking: { count: jest.fn().mockResolvedValue(0), create: jest.fn(), update: jest.fn() },
    customer: { findFirst: jest.fn().mockResolvedValue(null), upsert: jest.fn(), findUnique: jest.fn() },
    coupon: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn(), create: jest.fn() },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  db.$transaction = jest.fn((cb) => cb(db));
  return db;
});
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/lib/scheduler', () => ({ findAvailableCleaners: jest.fn() }));
jest.mock('../src/lib/cache', () => ({ get: jest.fn().mockResolvedValue(null), set: jest.fn() }));
jest.mock('../src/lib/pricing', () => ({
  calculateQuote: jest.fn(),
  computeDepositCents: jest.fn().mockResolvedValue(0),
}));
jest.mock('../src/lib/stripeClient', () => ({ createAncillaryCheckoutSession: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({
  notifyBookingCreated: jest.fn(), sendCustomerBookingConfirmation: jest.fn(),
}));
jest.mock('../src/lib/notificationClient', () => ({ sendSms: jest.fn().mockResolvedValue(undefined), sendEmail: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/modules/customers/customers.service', () => ({ ensureReferralCode: jest.fn().mockResolvedValue('REFCODE') }));

const prisma = require('../src/config/database.js');
const scheduler = require('../src/lib/scheduler');
const pricing = require('../src/lib/pricing');
const widget = require('../src/modules/widget/widget.service');
const { isWithinOpeningHours } = require('../src/lib/businessHours');

// Monday 2099-06-01 10:00 Amsterdam (CEST = UTC+2) -> 08:00Z. Far future so min-notice never bites.
const MON_10 = '2099-06-01T08:00:00.000Z';
const SUN_10 = '2099-05-31T08:00:00.000Z';
const hours = [
  { dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isClosed: false },
  { dayOfWeek: 0, openTime: '08:00', closeTime: '18:00', isClosed: true },
];

beforeEach(() => {
  jest.clearAllMocks();
  prisma.serviceArea.findMany.mockResolvedValue([]);
  prisma.booking.count.mockReset();
  prisma.booking.count.mockResolvedValue(0);
  scheduler.findAvailableCleaners.mockReset();
  prisma.customer.findFirst.mockResolvedValue(null);
  prisma.customer.upsert.mockResolvedValue({ id: 'c1', referralCode: null });
  prisma.service.findFirst.mockResolvedValue({ id: 's1', businessId: 'biz', estimatedMinutes: 120, addOns: [] });
  prisma.business.findUnique.mockResolvedValue({ timezone: 'Europe/Amsterdam', currency: 'eur' });
  prisma.businessHours.findMany.mockResolvedValue(hours);
  prisma.booking.create.mockImplementation(async ({ data }) => ({ id: 'bk1', ...data }));
  scheduler.findAvailableCleaners.mockResolvedValue([{ id: 'cl1' }]);
  pricing.calculateQuote.mockResolvedValue({ priceCents: 8000, breakdown: { estimatedMinutes: 120 } });
});

const payload = (over = {}) => ({
  firstName: 'A', lastName: 'B', email: 'a@b.nl', phone: '+31612345678',
  addressLine1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012LG',
  serviceId: 's1', scheduledStart: MON_10, ...over,
});

describe('opening hours', () => {
  test('isClosed rows never count as open', () => {
    const start = new Date(SUN_10); const end = new Date(start.getTime() + 2 * 3600000);
    expect(isWithinOpeningHours(hours, start, end, 'Europe/Amsterdam')).toBe(false);
  });
  test('inside / outside the window, in the business timezone', () => {
    const at = (iso, mins = 120) => [new Date(iso), new Date(new Date(iso).getTime() + mins * 60000)];
    expect(isWithinOpeningHours(hours, ...at(MON_10), 'Europe/Amsterdam')).toBe(true);
    expect(isWithinOpeningHours(hours, ...at('2099-06-01T01:00:00.000Z'), 'Europe/Amsterdam')).toBe(false); // 03:00 local
    expect(isWithinOpeningHours(hours, ...at('2099-06-01T15:00:00.000Z'), 'Europe/Amsterdam')).toBe(false); // ends 19:00 local
  });
  test('a window that runs past midnight also covers the next morning', () => {
    const night = [{ dayOfWeek: 5, openTime: '18:00', closeTime: '02:00', isClosed: false }]; // Friday
    const at = (iso, mins) => [new Date(iso), new Date(new Date(iso).getTime() + mins * 60000)];
    expect(isWithinOpeningHours(night, ...at('2099-06-05T16:00:00.000Z', 120), 'Europe/Amsterdam')).toBe(true); // Fri 18:00
    expect(isWithinOpeningHours(night, ...at('2099-06-05T22:30:00.000Z', 60), 'Europe/Amsterdam')).toBe(true); // Sat 00:30
    expect(isWithinOpeningHours(night, ...at('2099-06-06T22:30:00.000Z', 60), 'Europe/Amsterdam')).toBe(false); // Sun 00:30: Saturday has no window
  });
  test('slots() asks only for open rows (closed Sundays no longer offered)', async () => {
    prisma.businessHours.findMany.mockResolvedValue([]);
    const out = await widget.slots('biz', { serviceId: 's1', date: '2099-05-31' });
    expect(prisma.businessHours.findMany).toHaveBeenCalledWith({ where: { businessId: 'biz', dayOfWeek: 0, isClosed: false } });
    expect(out.slots).toEqual([]);
  });
  test('quote() rejects a time outside opening hours even when a cleaner is free', async () => {
    await expect(widget.quote('biz', { serviceId: 's1', scheduledStart: SUN_10 })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/closed/i) });
    await expect(widget.quote('biz', { serviceId: 's1', scheduledStart: MON_10 })).resolves.toMatchObject({ priceCents: 8000 });
  });
});

describe('quote tax block', () => {
  test('reports the BTW included in the (VAT-inclusive) price without changing the total', async () => {
    prisma.business.findUnique.mockResolvedValue({ timezone: 'Europe/Amsterdam', vatRateBps: 2100 });
    pricing.calculateQuote.mockResolvedValue({ priceCents: 12100, breakdown: { estimatedMinutes: 120 } });
    const q = await widget.quote('biz', { serviceId: 's1' });
    expect(q.priceCents).toBe(12100);
    expect(q.tax).toEqual({ pricesIncludeVat: true, vatRateBps: 2100, vatCents: 2100, netCents: 10000 });
  });
});

describe('custom booking questions on submit', () => {
  const Q = (over = {}) => ({ id: 'q1', label: 'Do you have pets?', type: 'YES_NO', options: [], required: true, serviceIds: [], sortOrder: 0, isActive: true, ...over });

  test('answers are stored on the booking as a snapshot that includes the question text', async () => {
    prisma.bookingQuestion.findMany.mockResolvedValueOnce([Q()]);
    await widget.submitBooking('biz', payload({ answers: [{ questionId: 'q1', value: true }] }));
    const data = prisma.booking.create.mock.calls[0][0].data;
    expect(data.customAnswers).toEqual([{ questionId: 'q1', label: 'Do you have pets?', type: 'YES_NO', value: true }]);
  });

  test('a missing required answer is rejected before anything is priced, locked or created', async () => {
    prisma.bookingQuestion.findMany.mockResolvedValueOnce([Q()]);
    await expect(widget.submitBooking('biz', payload({ answers: [] }))).rejects.toMatchObject({ status: 422 });
    expect(pricing.calculateQuote).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  test('a business with no questions books exactly as before', async () => {
    await widget.submitBooking('biz', payload());
    expect(prisma.booking.create.mock.calls[0][0].data.customAnswers).toBeUndefined();
  });

  test('only this business\'s questions are consulted', async () => {
    await widget.submitBooking('biz', payload()).catch(() => {});
    expect(prisma.bookingQuestion.findMany).toHaveBeenCalledWith({ where: { businessId: 'biz', isActive: true } });
  });
});

describe('booking creation is serialised and re-checked (no overselling)', () => {
  test('happy path takes the per-business advisory lock and writes inside it', async () => {
    const r = await widget.submitBooking('biz', payload());
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ timeout: expect.any(Number) }));
    expect(r.id).toBe('bk1');
  });

  test('the slot is re-checked inside the lock: a request that lost the race gets 409 and nothing is created', async () => {
    // 1st call = quote() (free), 2nd call = inside the lock (another request took it meanwhile)
    scheduler.findAvailableCleaners.mockResolvedValueOnce([{ id: 'cl1' }]).mockResolvedValueOnce([]);
    await expect(widget.submitBooking('biz', payload())).rejects.toMatchObject({ status: 409 });
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });

  test('coupon path is serialised too', async () => {
    prisma.coupon.findFirst.mockResolvedValue({ id: 'cp', code: 'X', isActive: true, maxRedemptions: 5 });
    prisma.coupon.updateMany.mockResolvedValue({ count: 1 });
    pricing.calculateQuote.mockResolvedValue({ priceCents: 7000, breakdown: { estimatedMinutes: 120 }, coupon: { code: 'X' } });
    await widget.submitBooking('biz', payload({ couponCode: 'X' }));
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    scheduler.findAvailableCleaners.mockResolvedValueOnce([{ id: 'cl1' }]).mockResolvedValueOnce([]);
    await expect(widget.submitBooking('biz', payload({ couponCode: 'X' }))).rejects.toMatchObject({ status: 409 });
  });

  test('missing/invalid scheduledStart is a 422, not a Prisma crash', async () => {
    await expect(widget.submitBooking('biz', payload({ scheduledStart: undefined }))).rejects.toMatchObject({ status: 422 });
    await expect(widget.submitBooking('biz', payload({ scheduledStart: 'nope' }))).rejects.toMatchObject({ status: 422 });
  });
});

describe('abuse controls', () => {
  test('one contact cannot create more than the daily cap of bookings', async () => {
    // customerId-scoped count = the daily cap query; the unscoped one is the capacity check
    prisma.booking.count.mockImplementation(async ({ where }) => (where.customerId ? 5 : 0));
    await expect(widget.submitBooking('biz', payload())).rejects.toMatchObject({ status: 429 });
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });
  test('the cap is configurable', async () => {
    process.env.WIDGET_MAX_BOOKINGS_PER_CUSTOMER_PER_DAY = '2';
    prisma.booking.count.mockResolvedValue(2);
    await expect(widget.assertCustomerNotSpamming(prisma, 'c1')).rejects.toMatchObject({ status: 429 });
    delete process.env.WIDGET_MAX_BOOKINGS_PER_CUSTOMER_PER_DAY;
  });
  test('a referrer cannot be "referred" by their own e-mail under a new phone number', async () => {
    prisma.customer.findFirst
      .mockResolvedValueOnce(null) // existing customer by phone
      .mockResolvedValueOnce({ id: 'ref', phone: '+31600000000', email: 'A@B.nl' }); // referrer
    const r = await widget.submitBooking('biz', payload({ referralCode: 'abc123' }));
    expect(r.referralDiscountCents).toBe(0);
  });
  test('a genuine referral still gets the discount', async () => {
    prisma.customer.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'ref', phone: '+31600000000', email: 'friend@x.nl' });
    const r = await widget.submitBooking('biz', payload({ referralCode: 'abc123' }));
    expect(r.referralDiscountCents).toBe(1000);
    expect(prisma.booking.create.mock.calls[0][0].data.quotedPriceCents).toBe(7000);
  });
});

describe('storefront', () => {
  test('does not expose Stripe ids or other internal business fields', async () => {
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz', name: 'Clean Co', subdomain: 'clean', timezone: 'Europe/Amsterdam', currency: 'eur',
      stripeConnectedAccountId: 'acct_secret', stripeChargesEnabled: true, parentBusinessId: 'org', customDomain: 'x.nl',
      preferredPaymentCollection: 'BOTH', offlinePaymentInstructions: 'IBAN ...', branding: null,
      // contactPhone is public (shown on the storefront); contactEmail is private - it is
      // where contact-form messages are delivered and must never reach this payload.
      contactPhone: '+31 20 123 4567', contactEmail: 'private-inbox@clean.nl',
      hours: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isClosed: false, id: 'h1', businessId: 'biz' }],
    });
    prisma.service.findMany.mockResolvedValue([{ id: 's1' }]);
    prisma.serviceArea.count.mockResolvedValue(1);
    const out = await widget.getStorefront('biz');
    expect(Object.keys(out.business).sort()).toEqual(['branding', 'currency', 'customDomain', 'defaultLocale', 'hours', 'id', 'legal', 'name', 'phone', 'subdomain', 'timezone']);
    // customDomain is set on the row but has no VERIFIED status, so it is not routed and must not be published
    expect(out.business.customDomain).toBeNull();
    expect(out.business.defaultLocale).toBe('nl');
    expect(out.business.phone).toBe('+31 20 123 4567');
    expect(JSON.stringify(out)).not.toContain('acct_secret');
    expect(JSON.stringify(out)).not.toContain('private-inbox@clean.nl');
    expect(out.business.hours[0]).toEqual({ dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isClosed: false });
    // payment info is still derived from the private fields
    expect(out.payment).toMatchObject({ onlineCardReady: true, offlineAccepted: true });
    expect(out.onboardingComplete).toBe(true);
  });

  test('publishes a VERIFIED custom domain and the business default language', async () => {
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz', name: 'Clean Co', subdomain: 'clean', timezone: 'Europe/Amsterdam', currency: 'eur',
      customDomain: 'schoon.nl', customDomainStatus: 'VERIFIED', defaultLocale: 'en', branding: null, hours: [],
    });
    prisma.service.findMany.mockResolvedValue([{ id: 's1' }]);
    prisma.serviceArea.count.mockResolvedValue(1);
    const out = await widget.getStorefront('biz');
    expect(out.business.customDomain).toBe('schoon.nl');
    expect(out.business.defaultLocale).toBe('en');
  });

  test('exposes the real configured cancellation policy, not a hardcoded default', async () => {
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz', name: 'Clean Co', subdomain: 'clean', timezone: 'Europe/Amsterdam', currency: 'eur',
      preferredPaymentCollection: 'BOTH', branding: null, hours: [],
    });
    prisma.service.findMany.mockResolvedValue([{ id: 's1' }]);
    prisma.serviceArea.count.mockResolvedValue(1);
    prisma.businessPricing.findUnique.mockResolvedValue({
      cancellationWindowHours: 24, cancellationFeeType: 'PERCENT', cancellationFeeValue: 50,
    });

    const out = await widget.getStorefront('biz');
    expect(out.cancellationPolicy).toEqual({ windowHours: 24, feeType: 'PERCENT', feeValue: 50 });
  });

  test('a business with no cancellation policy configured reports free-anytime (null window), not a made-up default', async () => {
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz', name: 'Clean Co', subdomain: 'clean', timezone: 'Europe/Amsterdam', currency: 'eur',
      preferredPaymentCollection: 'BOTH', branding: null, hours: [],
    });
    prisma.service.findMany.mockResolvedValue([{ id: 's1' }]);
    prisma.serviceArea.count.mockResolvedValue(1);
    prisma.businessPricing.findUnique.mockResolvedValue(null);

    const out = await widget.getStorefront('biz');
    expect(out.cancellationPolicy).toEqual({ windowHours: null, feeType: null, feeValue: null });
  });

  test('never leaves both online and offline payment unavailable, even if ONLINE_CARD was chosen before Stripe was ready', async () => {
    // businesses.service.updateBusiness now blocks *setting* ONLINE_CARD
    // before Stripe is chargeable, but this covers every other way the
    // combination could still occur (data predating that guard, Stripe
    // disconnecting after the preference was already ONLINE_CARD, etc.) —
    // a storefront must never end up with no way for the customer to pay.
    prisma.business.findUnique.mockResolvedValue({
      id: 'biz', name: 'Clean Co', subdomain: 'clean', timezone: 'Europe/Amsterdam', currency: 'eur',
      stripeChargesEnabled: false, stripeConnectedAccountId: null,
      preferredPaymentCollection: 'ONLINE_CARD', branding: null, hours: [],
    });
    prisma.service.findMany.mockResolvedValue([{ id: 's1' }]);
    prisma.serviceArea.count.mockResolvedValue(1);
    prisma.businessPricing.findUnique.mockResolvedValue(null);

    const out = await widget.getStorefront('biz');
    expect(out.payment).toEqual({ onlineCardReady: false, offlineAccepted: true, offlinePaymentInstructions: null });
  });
});
