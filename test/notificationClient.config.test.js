jest.mock('../src/config/database.js', () => ({}));
// The real queue opens a Redis connection that keeps jest alive.
jest.mock('../src/lib/queue', () => ({ enqueue: jest.fn(), sendEmail: jest.fn(), sendSms: jest.fn() }), { virtual: true });

describe('notificationClient environment', () => {
  const OLD = process.env;
  afterEach(() => { process.env = OLD; jest.resetModules(); });

  test('SMS works with the variable name that .env.example documents (TWILIO_FROM_NUMBER)', async () => {
    process.env = { ...OLD, TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: '+31000000000' };
    delete process.env.TWILIO_FROM;
    const create = jest.fn().mockResolvedValue({ sid: 'SM1' });
    jest.doMock('twilio', () => jest.fn(() => ({ messages: { create } })));
    const client = require('../src/lib/notificationClient');
    await client._sendSmsNow({ to: '+31611111111', body: 'hi' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ from: '+31000000000', to: '+31611111111' }));
  });
});
