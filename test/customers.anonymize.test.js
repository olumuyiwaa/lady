jest.mock('../src/config/database.js', () => {
  const db = {
    customer: { findFirst: jest.fn(), update: jest.fn(), delete: jest.fn() },
    booking: { count: jest.fn(), updateMany: jest.fn() },
    customerAddress: { deleteMany: jest.fn() },
    recurringSchedule: { updateMany: jest.fn() },
    waitlistEntry: { updateMany: jest.fn() },
    user: { findUnique: jest.fn(), delete: jest.fn() },
    otpCode: { deleteMany: jest.fn() },
  };
  db.$transaction = jest.fn((fn) => fn(db));
  return db;
});
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));

const prisma = require('../src/config/database.js');
const service = require('../src/modules/customers/customers.service');

describe('deleteCustomer (erasure request)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.customer.findFirst.mockResolvedValue({ id: 'c1', businessId: 'biz1', referralCode: 'REF1' });
    prisma.booking.count.mockResolvedValue(0);
    prisma.user.findUnique.mockResolvedValue({ id: 'pu1' });
  });

  test('never hard-deletes the customer, so bookings, earnings and reviews survive', async () => {
    await service.deleteCustomer('biz1', 'c1', 'owner1');
    expect(prisma.customer.delete).not.toHaveBeenCalled();
    expect(prisma.customer.update).toHaveBeenCalled();
  });

  test('removes everything that identifies the person', async () => {
    await service.deleteCustomer('biz1', 'c1', 'owner1');
    const data = prisma.customer.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ firstName: 'Verwijderd', email: null, notes: null, referralCode: null, phone: 'deleted-c1' });
    expect(prisma.customerAddress.deleteMany).toHaveBeenCalledWith({ where: { customerId: 'c1' } });
    const bookingScrub = prisma.booking.updateMany.mock.calls[0][0].data;
    expect(bookingScrub).toMatchObject({ addressLine1: 'Verwijderd', accessCode: null, keyLocation: null, latitude: null });
  });

  test('deletes the portal login identity and its codes', async () => {
    await service.deleteCustomer('biz1', 'c1', 'owner1');
    expect(prisma.otpCode.deleteMany).toHaveBeenCalledWith({ where: { userId: 'pu1' } });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'pu1' } });
  });

  test('still refuses while upcoming bookings exist', async () => {
    prisma.booking.count.mockResolvedValue(2);
    await expect(service.deleteCustomer('biz1', 'c1', 'owner1')).rejects.toMatchObject({ status: 422 });
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });
});
