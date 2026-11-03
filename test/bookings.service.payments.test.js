jest.mock('../src/config/database.js', () => ({
  booking: { findFirst: jest.fn(), update: jest.fn() },
  business: { findUnique: jest.fn() },
}));
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/modules/notifications/notifications.service', () => ({}));
jest.mock('../src/lib/stripeClient', () => ({
  createBookingCheckoutSession: jest.fn(),
  createAncillaryCheckoutSession: jest.fn(),
  createRefund: jest.fn(),
}));

const prisma = require('../src/config/database.js');
const { createBookingCheckoutSession } = require('../src/lib/stripeClient');
const service = require('../src/modules/bookings/bookings.service');

const booking = (over = {}) => ({
  id: 'bk1', businessId: 'biz1', status: 'COMPLETED', quotedPriceCents: 10000, paymentStatus: 'UNPAID',
  amountPaidCents: null, giftCardAppliedCents: null, depositRequiredCents: null, depositPaidAt: null, paymentNote: null,
  customer: { email: 'c@x.nl', firstName: 'C', lastName: 'D' }, service: { name: 'Clean' }, ...over,
});

describe('markPaymentReceived (manual / offline payments)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.booking.update.mockImplementation(({ data }) => Promise.resolve({ ...booking(), ...data }));
  });

  test('records the amount received and marks PAID when it covers the balance', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking());
    await service.markPaymentReceived('biz1', 'bk1', 'u1', { method: 'CASH' });
    const data = prisma.booking.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ paymentStatus: 'PAID', amountPaidCents: 10000 });
  });

  test('a part-payment is PARTIAL, not PAID, and the balance is tracked', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking());
    await service.markPaymentReceived('biz1', 'bk1', 'u1', { method: 'BANK_TRANSFER', amountCents: 4000 });
    expect(prisma.booking.update.mock.calls[0][0].data).toMatchObject({ paymentStatus: 'PARTIAL', amountPaidCents: 4000 });
  });

  test('a second payment adds to the first and completes the balance', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ paymentStatus: 'PARTIAL', amountPaidCents: 4000 }));
    await service.markPaymentReceived('biz1', 'bk1', 'u1', { amountCents: 6000 });
    expect(prisma.booking.update.mock.calls[0][0].data).toMatchObject({ paymentStatus: 'PAID', amountPaidCents: 10000 });
  });

  test('a deposit and gift card reduce the balance that has to be collected', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ depositRequiredCents: 2000, depositPaidAt: new Date(), giftCardAppliedCents: 3000, paymentStatus: 'DEPOSIT_PAID' }));
    await service.markPaymentReceived('biz1', 'bk1', 'u1', {});
    expect(prisma.booking.update.mock.calls[0][0].data).toMatchObject({ paymentStatus: 'PAID', amountPaidCents: 5000 });
  });

  test('rejects when nothing is left to collect', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ giftCardAppliedCents: 10000 }));
    await expect(service.markPaymentReceived('biz1', 'bk1', 'u1', {})).rejects.toMatchObject({ status: 409 });
  });
});

describe('createPaymentLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.business.findUnique.mockResolvedValue({ stripeChargesEnabled: true, stripeConnectedAccountId: 'acct_1', currency: 'eur' });
    createBookingCheckoutSession.mockResolvedValue({ id: 'cs_1', url: 'https://pay' });
  });

  test('charges only what is still owed, in the business currency, ignoring a client-supplied currency', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ depositRequiredCents: 2000, depositPaidAt: new Date(), giftCardAppliedCents: 3000 }));
    await service.createPaymentLink('biz1', 'bk1', 'u1', { currency: 'jpy' });
    expect(createBookingCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5000, currency: 'eur' }));
  });

  test('a booking already covered by deposit + gift card is marked PAID instead of billed again', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ depositRequiredCents: 4000, depositPaidAt: new Date(), giftCardAppliedCents: 6000 }));
    await expect(service.createPaymentLink('biz1', 'bk1', 'u1', {})).rejects.toMatchObject({ status: 409 });
    expect(createBookingCheckoutSession).not.toHaveBeenCalled();
    expect(prisma.booking.update).toHaveBeenCalledWith({ where: { id: 'bk1' }, data: { paymentStatus: 'PAID' } });
  });
});
