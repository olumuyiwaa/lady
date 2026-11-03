jest.mock('../src/config/database.js', () => {
  const tx = {
    bookingAssignment: { update: jest.fn(async ({ data }) => ({ id: 'as1', ...data })) },
    booking: { update: jest.fn() },
    cleanerProfile: { update: jest.fn() },
  };
  return {
    bookingAssignment: { findFirst: jest.fn() },
    cleanerProfile: { findUnique: jest.fn() },
    businessMember: { findFirst: jest.fn() },
    booking: { update: jest.fn() },
    $transaction: jest.fn(async (fn) => fn(tx)),
    __tx: tx,
  };
});
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/lib/geocode', () => ({ geocodeNl: jest.fn() }));

const prisma = require('../src/config/database.js');
const { audit } = require('../src/utils/audit');
const { geocodeNl } = require('../src/lib/geocode');
const service = require('../src/modules/cleaners/cleaners.service');

// Booking at Amsterdam Centraal; ~0 m vs ~1.1 km away.
const AT = { lat: 52.3791, lng: 4.9003 };
const FAR = { lat: 52.3891, lng: 4.9003 };

const assignment = (booking = {}) => ({
  id: 'as1', bookingId: 'bk1', cleanerId: 'cl1', checkedInAt: null,
  booking: { id: 'bk1', businessId: 'biz1', status: 'CONFIRMED', addressLine1: 'Stationsplein 1', postalCode: '1012AB', city: 'Amsterdam', latitude: AT.lat, longitude: AT.lng, ...booking },
  cleaner: { id: 'cl1' },
});

beforeEach(() => {
  jest.clearAllMocks();
  prisma.cleanerProfile.findUnique.mockResolvedValue({ id: 'cl1', userId: 'u-cleaner' });
  prisma.bookingAssignment.findFirst.mockResolvedValue(assignment());
});
const clockIn = (pos, actor = 'u-cleaner') => service.clockIn('biz1', 'cl1', 'as1', actor, pos);
const lastVerification = () => audit.mock.calls[audit.mock.calls.length - 1][0].metadata.verification;

describe('clockIn geofence', () => {
  test('on site: verified', async () => {
    await clockIn(AT);
    expect(lastVerification()).toBe('GEOFENCED');
  });
  test('too far away: rejected', async () => {
    await expect(clockIn(FAR)).rejects.toMatchObject({ status: 422 });
    expect(prisma.__tx.bookingAssignment.update).not.toHaveBeenCalled();
  });
  test('no device location: allowed, but recorded as unverified', async () => {
    await clockIn({});
    expect(lastVerification()).toBe('NO_DEVICE_LOCATION');
  });
  test('a manager clocking someone in is recorded as such', async () => {
    prisma.businessMember.findFirst.mockResolvedValue({ id: 'bm1' });
    await clockIn({}, 'u-manager');
    expect(lastVerification()).toBe('MANAGER');
  });
  test('a booking stored without coordinates is geocoded on the spot and the result is kept', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue(assignment({ latitude: null, longitude: null }));
    geocodeNl.mockResolvedValue({ latitude: AT.lat, longitude: AT.lng });
    await clockIn(AT);
    expect(prisma.booking.update).toHaveBeenCalledWith({ where: { id: 'bk1' }, data: { latitude: AT.lat, longitude: AT.lng } });
    expect(lastVerification()).toBe('GEOFENCED');
  });
  test('the geofence now applies to such a booking too', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue(assignment({ latitude: null, longitude: null }));
    geocodeNl.mockResolvedValue({ latitude: AT.lat, longitude: AT.lng });
    await expect(clockIn(FAR)).rejects.toMatchObject({ status: 422 });
  });
  test('if the address cannot be geocoded the check-in still works but is flagged', async () => {
    prisma.bookingAssignment.findFirst.mockResolvedValue(assignment({ latitude: null, longitude: null }));
    geocodeNl.mockResolvedValue(null);
    await clockIn(AT);
    expect(lastVerification()).toBe('NO_BOOKING_COORDINATES');
  });
});
