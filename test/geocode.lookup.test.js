jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { lookupNlAddress } = require('../src/lib/geocode');

const doc = { straatnaam: 'Damrak', woonplaatsnaam: 'Amsterdam', postcode: '1012LG', huisnummer: 1, huis_nlt: '1', centroide_ll: 'POINT(4.89 52.37)' };
const ok = (docs) => ({ ok: true, json: async () => ({ response: { docs } }) });

beforeEach(() => { global.fetch = jest.fn(); });

describe('lookupNlAddress', () => {
  test('returns street, city and coordinates, with the postcode formatted', async () => {
    global.fetch.mockResolvedValue(ok([doc]));
    await expect(lookupNlAddress({ postalCode: '1012lg', houseNumber: '1' })).resolves.toEqual({
      street: 'Damrak', houseNumber: '1', city: 'Amsterdam', postalCode: '1012 LG', latitude: 52.37, longitude: 4.89,
    });
    expect(global.fetch.mock.calls[0][0]).toContain('q=1012LG%201');
  });
  test('rejects malformed input without calling the geocoder', async () => {
    for (const input of [{ postalCode: '0123AB', houseNumber: '1' }, { postalCode: '1012LG', houseNumber: 'x; DROP' }, {}]) {
      await expect(lookupNlAddress(input)).resolves.toBeNull();
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('refuses a fuzzy hit for a different postcode', async () => {
    global.fetch.mockResolvedValue(ok([{ ...doc, postcode: '1013AA' }]));
    await expect(lookupNlAddress({ postalCode: '1012LG', houseNumber: '1' })).resolves.toBeNull();
  });
  test('no match, upstream error and network failure all give null', async () => {
    global.fetch.mockResolvedValueOnce(ok([]));
    await expect(lookupNlAddress({ postalCode: '1012LG', houseNumber: '1' })).resolves.toBeNull();
    global.fetch.mockResolvedValueOnce({ ok: false });
    await expect(lookupNlAddress({ postalCode: '1012LG', houseNumber: '1' })).resolves.toBeNull();
    global.fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(lookupNlAddress({ postalCode: '1012LG', houseNumber: '1' })).resolves.toBeNull();
  });
});
