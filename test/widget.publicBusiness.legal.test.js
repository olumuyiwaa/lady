jest.mock('../src/config/database.js', () => ({}));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { toPublicBusiness } = require('../src/modules/widget/widget.service');

const row = {
  id: 'b1', name: 'Schoon BV', subdomain: 'schoon', timezone: 'Europe/Amsterdam', currency: 'eur',
  contactPhone: '+31201234567', contactEmail: 'inbox@schoon.nl', kvkNumber: '12345678', vatNumber: 'NL123456789B01',
  stripeConnectedAccountId: 'acct_secret', hours: [],
  addresses: [{ line1: 'Damrak 1', postalCode: '1012LG', city: 'Amsterdam', country: 'NL', latitude: 1, longitude: 2 }],
};

describe('toPublicBusiness legal block', () => {
  test('exposes KvK, BTW and the registered address', () => {
    expect(toPublicBusiness(row).legal).toEqual({
      kvkNumber: '12345678', vatNumber: 'NL123456789B01',
      address: { line1: 'Damrak 1', postalCode: '1012LG', city: 'Amsterdam', country: 'NL' },
    });
  });
  test('still never leaks the private contact email, Stripe ids or coordinates', () => {
    const json = JSON.stringify(toPublicBusiness(row));
    expect(json).not.toContain('inbox@schoon.nl');
    expect(json).not.toContain('acct_secret');
    expect(json).not.toContain('latitude');
  });
  test('missing details come through as null, not as an error', () => {
    expect(toPublicBusiness({ ...row, kvkNumber: null, vatNumber: null, addresses: [] }).legal).toEqual({ kvkNumber: null, vatNumber: null, address: null });
  });
});
