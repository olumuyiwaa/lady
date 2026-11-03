jest.mock('../src/config/database.js', () => ({ serviceArea: { findMany: jest.fn() } }));
jest.mock('../src/lib/geocode', () => ({ geocodeNl: jest.fn(), lookupNlAddress: jest.fn() }));
jest.mock('../src/lib/stripeClient', () => ({ createAncillaryCheckoutSession: jest.fn() }));

const prisma = require('../src/config/database.js');
const { geocodeNl } = require('../src/lib/geocode');
const widget = require('../src/modules/widget/widget.service');

// A 5 km circle around Amsterdam Centraal.
const amsterdam = { centerLat: 52.3791, centerLng: 4.9003, radiusMeters: 5000 };
let n = 0;
const freshPostcode = () => `10${String(10 + n++).padStart(2, '0')}AB`; // a new postcode each time: the service memoises coordinates

beforeEach(() => jest.resetAllMocks());

test('rejects anything that is not a Dutch postcode, without touching the geocoder', async () => {
  for (const bad of ['', 'abc', '0123 AB', '12345', '1012']) {
    await expect(widget.checkServiceArea('biz', { postalCode: bad })).rejects.toMatchObject({ status: 422 });
  }
  expect(geocodeNl).not.toHaveBeenCalled();
});

test('a business with no service areas serves everywhere (restricted: false)', async () => {
  prisma.serviceArea.findMany.mockResolvedValue([]);
  const out = await widget.checkServiceArea('biz', { postalCode: '1012 ab' });
  expect(out).toEqual({ postalCode: '1012AB', covered: true, restricted: false });
  expect(geocodeNl).not.toHaveBeenCalled();
});

test('covered when the postcode falls inside a service area', async () => {
  prisma.serviceArea.findMany.mockResolvedValue([amsterdam]);
  geocodeNl.mockResolvedValue({ latitude: 52.37, longitude: 4.9 });
  const out = await widget.checkServiceArea('biz', { postalCode: freshPostcode() });
  expect(out).toMatchObject({ covered: true, restricted: true });
});

test('not covered when the postcode is outside every area', async () => {
  prisma.serviceArea.findMany.mockResolvedValue([amsterdam]);
  geocodeNl.mockResolvedValue({ latitude: 51.9244, longitude: 4.4777 }); // Rotterdam
  const out = await widget.checkServiceArea('biz', { postalCode: freshPostcode() });
  expect(out).toMatchObject({ covered: false, restricted: true });
});

test('null (unknown) when the geocoder cannot place the postcode - never claims either way', async () => {
  prisma.serviceArea.findMany.mockResolvedValue([amsterdam]);
  geocodeNl.mockResolvedValue(null);
  const out = await widget.checkServiceArea('biz', { postalCode: freshPostcode() });
  expect(out).toMatchObject({ covered: null, restricted: true });
});

test('scopes the lookup to the business and never returns the area geometry', async () => {
  prisma.serviceArea.findMany.mockResolvedValue([amsterdam]);
  geocodeNl.mockResolvedValue({ latitude: 52.37, longitude: 4.9 });
  const out = await widget.checkServiceArea('biz-42', { postalCode: freshPostcode() });
  expect(prisma.serviceArea.findMany).toHaveBeenCalledWith({ where: { businessId: 'biz-42' } });
  expect(JSON.stringify(out)).not.toMatch(/centerLat|centerLng|radius/);
});

test('successful geocodes are cached; failures are not', async () => {
  prisma.serviceArea.findMany.mockResolvedValue([amsterdam]);
  const pc = freshPostcode();
  geocodeNl.mockResolvedValueOnce(null).mockResolvedValue({ latitude: 52.37, longitude: 4.9 });
  await widget.checkServiceArea('biz', { postalCode: pc });  // fails -> not cached
  await widget.checkServiceArea('biz', { postalCode: pc });  // succeeds -> cached
  await widget.checkServiceArea('biz', { postalCode: pc });  // served from cache
  expect(geocodeNl).toHaveBeenCalledTimes(2);
});
