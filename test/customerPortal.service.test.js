jest.mock('../src/config/database.js', () => ({
  customer: { findFirst: jest.fn() },
  user: { findUnique: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
  otpCode: { count: jest.fn(), updateMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() },
}));
jest.mock('../src/lib/notificationClient', () => ({ sendSms: jest.fn(), sendEmail: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({ createRefund: jest.fn(), createAncillaryCheckoutSession: jest.fn() }));

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../src/config/database.js');
const notificationClient = require('../src/lib/notificationClient');
const service = require('../src/modules/customerPortal/customerPortal.service');
const { requireCustomerPortal } = require('../src/modules/customerPortal/customerPortal.middleware');
const { authenticate } = require('../src/middleware/authenticate');

process.env.JWT_SECRET = 'test-secret';

const customer = { id: 'cust1', firstName: 'A', lastName: 'B', phone: '+31612345678', email: 'a@b.nl' };
const portalUser = { id: 'pu1', email: 'portal-cust1@portal.invalid' };
const hash = (userId, code) => crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');

describe('customerPortal access', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.customer.findFirst.mockResolvedValue(customer);
    prisma.user.findUnique.mockResolvedValue(portalUser);
  });

  test('never attaches the OTP to a User found by phone number', async () => {
    prisma.otpCode.count.mockResolvedValue(0);
    await service.requestAccess('biz1', { phone: customer.phone });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'portal-cust1@portal.invalid' } });
  });

  test('stores only a hash of the code and sends the plain code to the customer', async () => {
    prisma.otpCode.count.mockResolvedValue(0);
    await service.requestAccess('biz1', { phone: customer.phone });
    const stored = prisma.otpCode.create.mock.calls[0][0].data;
    const sms = notificationClient.sendSms.mock.calls[0][0].body;
    const plain = sms.match(/\d{6}/)[0];
    expect(stored.code).toBe(hash('pu1', plain));
    expect(stored.code).not.toContain(plain);
  });

  test('caps code requests per window without changing the response shape', async () => {
    prisma.otpCode.count.mockResolvedValue(3);
    const result = await service.requestAccess('biz1', { phone: customer.phone });
    expect(result).toEqual({ sent: true });
    expect(notificationClient.sendSms).not.toHaveBeenCalled();
    expect(prisma.otpCode.create).not.toHaveBeenCalled();
  });

  test('locks verification after repeated wrong guesses, even for the right code', async () => {
    prisma.otpCode.count.mockResolvedValue(5);
    await expect(service.verifyAccess('biz1', { phone: customer.phone, code: '123456' })).rejects.toMatchObject({ status: 429 });
    expect(prisma.otpCode.findFirst).not.toHaveBeenCalled();
    expect(prisma.otpCode.updateMany).toHaveBeenCalled();
  });

  test('records a failed attempt when the code is wrong', async () => {
    prisma.otpCode.count.mockResolvedValue(0);
    prisma.otpCode.findFirst.mockResolvedValue(null);
    await expect(service.verifyAccess('biz1', { phone: customer.phone, code: '000000' })).rejects.toMatchObject({ status: 401 });
    expect(prisma.otpCode.create.mock.calls[0][0].data.purpose).toBe('CUSTOMER_PORTAL_FAILED');
  });

  test('a correct code yields a portal-audience token bound to the customer', async () => {
    prisma.otpCode.count.mockResolvedValue(0);
    prisma.otpCode.findFirst.mockResolvedValue({ id: 'otp1' });
    const { token } = await service.verifyAccess('biz1', { phone: customer.phone, code: '123456' });
    const payload = jwt.verify(token, 'test-secret');
    expect(payload).toMatchObject({ sub: 'pu1', businessId: 'biz1', portalCustomerId: 'cust1', scope: 'CUSTOMER_PORTAL', aud: 'customer-portal' });
    expect(prisma.otpCode.findFirst.mock.calls[0][0].where.code).toBe(hash('pu1', '123456'));
  });

  test('finds a customer however the phone was typed or stored (06 vs +31)', async () => {
    await service.requestAccess('biz1', { phone: '06 12345678' });
    const where = prisma.customer.findFirst.mock.calls[0][0].where;
    expect(where.businessId).toBe('biz1');
    // A customer stored as "0612345678" or "+31612345678" must both match.
    expect(where.phone.in).toEqual(expect.arrayContaining(['+31612345678', '0612345678', '06 12345678']));
  });

  test('an unknown phone still gets the normal response shape (no account enumeration)', async () => {
    prisma.customer.findFirst.mockResolvedValue(null);
    const result = await service.requestAccess('biz1', { phone: '+31600000000' });
    expect(result).toEqual({ sent: true });
    expect(prisma.otpCode.create).not.toHaveBeenCalled();
  });
});

describe('customerPortal access by email', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.customer.findFirst.mockResolvedValue(customer);
    prisma.user.findUnique.mockResolvedValue(portalUser);
    prisma.otpCode.count.mockResolvedValue(0);
  });

  test('looks the customer up by email, case-insensitively, scoped to the business', async () => {
    await service.requestAccess('biz1', { email: '  A@B.nl ' });
    const where = prisma.customer.findFirst.mock.calls[0][0].where;
    expect(where).toEqual({ businessId: 'biz1', email: { equals: 'a@b.nl', mode: 'insensitive' } });
  });

  test('sends the code by email ONLY - an email login never costs an SMS', async () => {
    await service.requestAccess('biz1', { email: customer.email });
    expect(notificationClient.sendSms).not.toHaveBeenCalled();
    expect(notificationClient.sendEmail).toHaveBeenCalledTimes(1);
    expect(notificationClient.sendEmail.mock.calls[0][0].to).toBe(customer.email);
  });

  test('a phone login still sends SMS and email (unchanged)', async () => {
    await service.requestAccess('biz1', { phone: customer.phone });
    expect(notificationClient.sendSms).toHaveBeenCalledTimes(1);
    expect(notificationClient.sendEmail).toHaveBeenCalledTimes(1);
  });

  test('phone takes precedence when both are supplied', async () => {
    await service.requestAccess('biz1', { phone: customer.phone, email: 'other@x.nl' });
    expect(notificationClient.sendSms).toHaveBeenCalledTimes(1);
  });

  test('an unknown email gets the normal response shape (no account enumeration)', async () => {
    prisma.customer.findFirst.mockResolvedValue(null);
    await expect(service.requestAccess('biz1', { email: 'nobody@x.nl' })).resolves.toEqual({ sent: true });
    expect(notificationClient.sendEmail).not.toHaveBeenCalled();
    expect(prisma.otpCode.create).not.toHaveBeenCalled();
  });

  test('with neither phone nor email nothing is looked up or sent', async () => {
    await expect(service.requestAccess('biz1', {})).resolves.toEqual({ sent: true });
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  test('verify works with an email and issues a portal-audience token', async () => {
    prisma.otpCode.findFirst.mockResolvedValue({ id: 'otp1' });
    const out = await service.verifyAccess('biz1', { email: customer.email, code: '123456' });
    expect(jwt.verify(out.token, 'test-secret', { audience: 'customer-portal' }).portalCustomerId).toBe('cust1');
  });

  test('wrong code by email counts as a failed attempt like any other', async () => {
    prisma.otpCode.findFirst.mockResolvedValue(null);
    await expect(service.verifyAccess('biz1', { email: customer.email, code: '000000' })).rejects.toMatchObject({ status: 401 });
    expect(prisma.otpCode.create.mock.calls[0][0].data.purpose).toBe('CUSTOMER_PORTAL_FAILED');
  });
});

describe('portal tokens versus staff sessions', () => {
  const portalToken = () => jwt.sign(
    { sub: 'staff-user', businessId: 'biz1', portalCustomerId: 'c1', scope: 'CUSTOMER_PORTAL' },
    'test-secret', { audience: 'customer-portal' }
  );

  test('authenticate() rejects a portal token', async () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await authenticate({ headers: { authorization: `Bearer ${portalToken()}` } }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('requireCustomerPortal rejects an ordinary access token', () => {
    const access = jwt.sign({ sub: 'u1', businessId: 'biz1' }, 'test-secret');
    const next = jest.fn();
    requireCustomerPortal({ headers: { authorization: `Bearer ${access}` } }, {}, next);
    expect(next.mock.calls[0][0].status).toBe(401);
  });
});
