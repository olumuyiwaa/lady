jest.mock('../src/config/database', () => ({ customer: { findMany: jest.fn(), updateMany: jest.fn() } }));
jest.mock('twilio', () => Object.assign(jest.fn(), { validateRequest: jest.fn() }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/lib/notificationClient', () => ({
  sendEmail: jest.fn().mockResolvedValue({}),
  sendSms: jest.fn().mockResolvedValue({}),
  sendWhatsapp: jest.fn().mockResolvedValue({}),
}));
const client = require('../src/lib/notificationClient');
const { notifyCustomer } = require('../src/lib/customerNotify');
const messages = require('../src/lib/messages');
const { canWhatsapp, contentSid } = require('../src/lib/whatsapp');
const { languageFor, normalizeLanguage } = require('../src/lib/i18n');
const { classify } = require('../src/modules/webhooks/whatsapp.controller');

const base = { firstName: 'Anna', email: 'a@x.nl', phone: '+31612345678' };
const opted = { ...base, whatsappOptInAt: new Date('2026-01-01') };
beforeEach(() => { jest.clearAllMocks(); delete process.env.TWILIO_WA_CONTENT_REMINDER_NL; delete process.env.DEFAULT_CUSTOMER_LANGUAGE; });

describe('language', () => {
  test('normalises and falls back', () => {
    expect(normalizeLanguage('EN-gb')).toBe('en');
    expect(normalizeLanguage('fr')).toBeNull();
    expect(languageFor({})).toBe('nl');
    process.env.DEFAULT_CUSTOMER_LANGUAGE = 'en';
    expect(languageFor({ language: null })).toBe('en');
    expect(languageFor({ language: 'nl' })).toBe('nl');
  });
  test('every template exists in both languages with the same variables used', () => {
    for (const [key, tpl] of Object.entries(messages.templates)) {
      const vars = Object.fromEntries(tpl.vars.map((v) => [v, `<${v}>`]));
      for (const lang of ['nl', 'en']) {
        const out = messages.render(key, lang, vars);
        expect(out.text.length).toBeGreaterThan(10);
      }
    }
  });
  test('whatsapp variables are positional', () => {
    expect(messages.whatsappVariables('reminder', { name: 'Anna', when: 'maandag' })).toEqual({ 1: 'Anna', 2: 'maandag' });
  });
});

describe('canWhatsapp', () => {
  test('needs an opt-in newer than any opt-out', () => {
    expect(canWhatsapp(base)).toBe(false);
    expect(canWhatsapp(opted)).toBe(true);
    expect(canWhatsapp({ ...opted, whatsappOptOutAt: new Date('2026-02-01') })).toBe(false);
    expect(canWhatsapp({ ...opted, whatsappOptOutAt: new Date('2025-12-01') })).toBe(true);
  });
  test('content SID is read per key and language', () => {
    process.env.TWILIO_WA_CONTENT_REMINDER_NL = 'HX1';
    expect(contentSid('reminder', 'nl')).toBe('HX1');
    expect(contentSid('reminder', 'en')).toBeNull();
  });
});

describe('notifyCustomer', () => {
  test('SMS + email in Dutch for a customer without consent', async () => {
    const sent = await notifyCustomer(base, 'reminder', { name: 'Anna', when: 'maandag' });
    expect(sent).toMatchObject({ email: true, sms: true, whatsapp: false, language: 'nl' });
    expect(client.sendSms.mock.calls[0][0].body).toMatch(/herinnering/);
    expect(client.sendWhatsapp).not.toHaveBeenCalled();
  });
  test('WhatsApp replaces SMS for an opted-in customer with a configured template', async () => {
    process.env.TWILIO_WA_CONTENT_REMINDER_NL = 'HX1';
    const sent = await notifyCustomer(opted, 'reminder', { name: 'Anna', when: 'maandag' });
    expect(sent).toMatchObject({ whatsapp: true, sms: false, email: true });
    expect(client.sendWhatsapp).toHaveBeenCalledWith({ to: '+31612345678', contentSid: 'HX1', variables: { 1: 'Anna', 2: 'maandag' } });
    expect(client.sendSms).not.toHaveBeenCalled();
  });
  test('falls back to SMS when no template is configured', async () => {
    const sent = await notifyCustomer(opted, 'reminder', { name: 'Anna', when: 'x' });
    expect(sent).toMatchObject({ whatsapp: false, sms: true });
  });
  test('falls back to SMS when WhatsApp fails', async () => {
    process.env.TWILIO_WA_CONTENT_REMINDER_NL = 'HX1';
    client.sendWhatsapp.mockRejectedValueOnce(new Error('boom'));
    const sent = await notifyCustomer(opted, 'reminder', { name: 'Anna', when: 'x' });
    expect(sent).toMatchObject({ whatsapp: false, sms: true });
  });
  test('access codes never use WhatsApp', async () => {
    process.env.TWILIO_WA_CONTENT_ACCESSCODE_NL = 'HX9';
    await notifyCustomer(opted, 'accessCode', { business: 'Tod', code: '123456' });
    expect(client.sendWhatsapp).not.toHaveBeenCalled();
    expect(client.sendSms.mock.calls[0][0].body).toContain('123456');
    delete process.env.TWILIO_WA_CONTENT_ACCESSCODE_NL;
  });
  test('phone:false sends email only', async () => {
    await notifyCustomer(base, 'chatMessage', { business: 'Tod', who: 'Sam', preview: 'hi' }, { phone: false });
    expect(client.sendSms).not.toHaveBeenCalled();
    expect(client.sendEmail).toHaveBeenCalled();
  });
  test('an email failure does not stop the SMS', async () => {
    client.sendEmail.mockRejectedValueOnce(new Error('smtp'));
    const sent = await notifyCustomer(base, 'reminder', { name: 'A', when: 'x' });
    expect(sent).toMatchObject({ email: false, sms: true });
  });
});

describe('inbound keywords', () => {
  test.each([['STOP', 'stop'], [' Stoppen. ', 'stop'], ['Aan', 'start'], ['start', 'start'], ['hello', null], ['', null]])('%j -> %j', (body, want) => {
    expect(classify(body)).toBe(want);
  });
});

describe('whatsapp webhook', () => {
  const prisma = require('../src/config/database');
  const twilio = require('twilio');
  const { handle } = require('../src/modules/webhooks/whatsapp.controller');
  const mkRes = () => { const r = { status: jest.fn(() => r), type: jest.fn(() => r), send: jest.fn(() => r) }; return r; };
  const req = (body) => ({ body, originalUrl: '/api/v1/webhooks/whatsapp', get: () => 'sig' });
  beforeEach(() => { process.env.TWILIO_AUTH_TOKEN = 'tok'; twilio.validateRequest.mockReturnValue(true); });

  test('rejects a bad signature', async () => {
    twilio.validateRequest.mockReturnValue(false);
    const res = mkRes();
    await handle(req({ From: 'whatsapp:+31612345678', Body: 'STOP' }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prisma.customer.updateMany).not.toHaveBeenCalled();
  });
  test('STOP records an opt-out and answers in the customer language', async () => {
    prisma.customer.findMany.mockResolvedValue([{ id: 'c1', language: 'en' }]);
    const res = mkRes();
    await handle(req({ From: 'whatsapp:+31612345678', Body: 'stop' }), res, jest.fn());
    expect(prisma.customer.findMany.mock.calls[0][0].where).toEqual({ phone: '+31612345678' });
    expect(prisma.customer.updateMany.mock.calls[0][0].data).toHaveProperty('whatsappOptOutAt');
    expect(res.send.mock.calls[0][0]).toContain('no longer receive');
  });
  test('START records an opt-in', async () => {
    prisma.customer.findMany.mockResolvedValue([{ id: 'c1', language: null }]);
    const res = mkRes();
    await handle(req({ From: 'whatsapp:+31612345678', Body: 'START' }), res, jest.fn());
    expect(prisma.customer.updateMany.mock.calls[0][0].data).toHaveProperty('whatsappOptInAt');
    expect(res.send.mock.calls[0][0]).toContain('ontvangt weer');
  });
  test('other messages change nothing', async () => {
    const res = mkRes();
    await handle(req({ From: 'whatsapp:+31612345678', Body: 'hello' }), res, jest.fn());
    expect(prisma.customer.updateMany).not.toHaveBeenCalled();
  });
});
