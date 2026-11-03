jest.mock('../src/config/database.js', () => ({
  booking: { findFirst: jest.fn(), update: jest.fn() },
  business: { findUnique: jest.fn() },
}));
jest.mock('../src/lib/notificationClient', () => ({ sendSms: jest.fn(), sendEmail: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({ createRefund: jest.fn(), createAncillaryCheckoutSession: jest.fn() }));

const prisma = require('../src/config/database.js');
const service = require('../src/modules/customerPortal/customerPortal.service');

const done = { id: 'bk1', status: 'COMPLETED', tipPaidAt: null };
const tip = (amountCents) => service.tipMyBooking('biz1', 'cust1', 'bk1', { amountCents, successUrl: 'https://x/y', cancelUrl: 'https://x/z' });

beforeEach(() => { jest.resetAllMocks(); prisma.booking.findFirst.mockResolvedValue(done); });

describe('tipMyBooking guards', () => {
  test('refuses a second tip once one has been paid', async () => {
    prisma.booking.findFirst.mockResolvedValue({ ...done, tipPaidAt: new Date() });
    await expect(tip(500)).rejects.toMatchObject({ status: 409 });
  });
  test('refuses fractional, tiny and oversized amounts', async () => {
    await expect(tip(12.5)).rejects.toMatchObject({ status: 422 });
    await expect(tip(10)).rejects.toMatchObject({ status: 422 });
    await expect(tip(service.MAX_TIP_CENTS + 1)).rejects.toMatchObject({ status: 422 });
  });
  test('refuses tips on bookings that are not completed', async () => {
    prisma.booking.findFirst.mockResolvedValue({ ...done, status: 'CONFIRMED' });
    await expect(tip(500)).rejects.toMatchObject({ status: 422 });
  });
});

describe('write paths use the light lookup', () => {
  test('findMyBooking does not load photos, checklist or assignments', async () => {
    await service.findMyBooking('biz1', 'cust1', 'bk1');
    const { include, where } = prisma.booking.findFirst.mock.calls[0][0];
    expect(where).toEqual({ id: 'bk1', businessId: 'biz1', customerId: 'cust1' });
    expect(Object.keys(include).sort()).toEqual(['review', 'service']);
  });
  test('a booking that belongs to someone else is a 404', async () => {
    prisma.booking.findFirst.mockResolvedValue(null);
    await expect(service.findMyBooking('biz1', 'other', 'bk1')).rejects.toMatchObject({ status: 404 });
  });
});
