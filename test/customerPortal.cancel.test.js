jest.mock('../src/config/database.js', () => ({ booking: { findFirst: jest.fn() } }));
jest.mock('../src/lib/notificationClient', () => ({}));
jest.mock('../src/lib/stripeClient', () => ({ createAncillaryCheckoutSession: jest.fn() }));
jest.mock('../src/modules/bookings/bookings.service', () => ({ cancelBooking: jest.fn().mockResolvedValue({ id: 'bk1', status: 'CANCELLED' }) }));

const prisma = require('../src/config/database.js');
const bookings = require('../src/modules/bookings/bookings.service');
const portal = require('../src/modules/customerPortal/customerPortal.service');

describe('customerPortal.cancelMyBooking', () => {
  beforeEach(() => jest.clearAllMocks());

  test("uses the shared cancellation path (refunds, gift card, notifications) for the customer's own booking", async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: 'bk1', status: 'CONFIRMED' });
    await portal.cancelMyBooking('biz1', 'cust1', 'bk1', undefined);
    expect(prisma.booking.findFirst.mock.calls[0][0].where).toEqual({ id: 'bk1', businessId: 'biz1', customerId: 'cust1' });
    expect(bookings.cancelBooking).toHaveBeenCalledWith('biz1', 'bk1', null, 'Cancelled by customer');
  });

  test("cannot cancel someone else's booking", async () => {
    prisma.booking.findFirst.mockResolvedValue(null);
    await expect(portal.cancelMyBooking('biz1', 'cust1', 'other', 'x')).rejects.toMatchObject({ status: 404 });
    expect(bookings.cancelBooking).not.toHaveBeenCalled();
  });

  test('an in-progress job cannot be cancelled by the customer', async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: 'bk1', status: 'IN_PROGRESS' });
    await expect(portal.cancelMyBooking('biz1', 'cust1', 'bk1', 'x')).rejects.toMatchObject({ status: 422 });
    expect(bookings.cancelBooking).not.toHaveBeenCalled();
  });
});
