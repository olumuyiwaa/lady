jest.mock('../src/config/database.js', () => ({
  business: { findUnique: jest.fn().mockResolvedValue({ subdomain: 'schoon', timezone: 'Europe/Amsterdam' }) },
  customer: { findUnique: jest.fn() },
  businessMember: { findMany: jest.fn().mockResolvedValue([]) },
  notification: { create: jest.fn() },
}));
jest.mock('../src/config/socket', () => ({ getIo: () => ({ to: () => ({ emit: jest.fn() }) }) }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/lib/notificationClient', () => ({ sendEmail: jest.fn().mockResolvedValue(undefined), sendSms: jest.fn().mockResolvedValue(undefined), sendPush: jest.fn() }));

process.env.APP_URL = 'https://app.example.nl';
const prisma = require('../src/config/database.js');
const client = require('../src/lib/notificationClient');
const n = require('../src/modules/notifications/notifications.service');

const customer = { firstName: 'Anna', email: 'a@x.nl', phone: '+31612345678' };
const booking = { id: 'bk1', customerId: 'c1', scheduledStart: new Date('2099-06-01T08:00:00Z') };
beforeEach(() => { jest.clearAllMocks(); });

test('the three functions completion relies on now exist', () => {
  for (const fn of ['requestCustomerReview', 'sendCustomerPaymentLink', 'notifyPaymentRequest', 'notifyBookingConfirmed', 'notifyCleanerUnassigned']) {
    expect(typeof n[fn]).toBe('function');
  }
});

test('review request contains the link where the review is left', async () => {
  await n.requestReview('biz', booking, customer);
  const sms = client.sendSms.mock.calls[0][0].body;
  expect(sms).toContain('https://app.example.nl/schoon/portal');
  expect(client.sendEmail.mock.calls[0][0].text).toContain('https://app.example.nl/schoon/portal');
});

test('payment link message goes to both channels with the URL', async () => {
  await n.sendCustomerPaymentLink('biz', booking, customer, 'https://pay.example/abc');
  expect(client.sendSms.mock.calls[0][0].body).toContain('https://pay.example/abc');
  expect(client.sendEmail).toHaveBeenCalled();
});

test('notifyPaymentRequest loads the customer when the booking does not carry it', async () => {
  prisma.customer.findUnique.mockResolvedValue(customer);
  await n.notifyPaymentRequest('biz', booking, 'https://pay.example/abc');
  expect(prisma.customer.findUnique).toHaveBeenCalledWith({ where: { id: 'c1' } });
  expect(client.sendEmail).toHaveBeenCalled();
});

test('confirmation message tells the customer the booking is confirmed', async () => {
  await n.notifyBookingConfirmed('biz', { ...booking, customer });
  expect(client.sendSms.mock.calls[0][0].body).toMatch(/confirmed/);
});
