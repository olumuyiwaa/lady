// createReview used to spread the request body straight into
// prisma.review.create — bookingId, customerId and cleanerId all came from
// the client, with only bookingId checked for presence (never for which
// business it actually belongs to). Business A could POST a bookingId that
// belongs to business B and have a review persisted under A that carries
// B's customerId and — via the assignment lookup — B's cleanerId, exposing
// another business's customer/cleaner identities and polluting their data
// with a rating that was never really theirs.
//
// These tests pin the fix: every id that ends up on the created row must
// first be proven to belong to the calling business.

jest.mock('../src/config/database.js', () => ({
  review: { findFirst: jest.fn(), create: jest.fn(), delete: jest.fn() },
  booking: { findFirst: jest.fn() },
  bookingAssignment: { findFirst: jest.fn() },
  cleanerProfile: { findFirst: jest.fn() },
}));

const prisma = require('../src/config/database.js');
const service = require('../src/modules/reviews/reviews.service');

const OWN_BUSINESS = 'biz-A';
const OTHER_BUSINESS = 'biz-B';

beforeEach(() => {
  jest.clearAllMocks();
  prisma.review.create.mockImplementation(async ({ data }) => ({ id: 'rv1', ...data }));
});

describe('createReview — cross-tenant bookingId', () => {
  test('rejects a bookingId that belongs to a different business', async () => {
    // The booking exists, but not under this business — findFirst scoped by
    // { id, businessId } correctly returns null for the caller's business.
    prisma.booking.findFirst.mockResolvedValue(null);

    await expect(
      service.createReview(OWN_BUSINESS, { bookingId: 'booking-owned-by-B', rating: 5 })
    ).rejects.toMatchObject({ status: 404 });

    expect(prisma.booking.findFirst).toHaveBeenCalledWith({
      where: { id: 'booking-owned-by-B', businessId: OWN_BUSINESS },
      select: { id: true, customerId: true },
    });
    expect(prisma.review.create).not.toHaveBeenCalled();
    // Must never infer a cleaner from another business's assignment before
    // the booking itself has been proven to belong to this business.
    expect(prisma.bookingAssignment.findFirst).not.toHaveBeenCalled();
  });

  test('accepts a bookingId that belongs to this business, and takes customerId from the booking — never from the request body', async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: 'bk1', customerId: 'cust-real' });
    prisma.bookingAssignment.findFirst.mockResolvedValue({ cleanerId: 'cl-real' });

    // A malicious or simply stale client sending a different customerId in
    // the body must not override the one derived from the booking.
    const created = await service.createReview(OWN_BUSINESS, {
      bookingId: 'bk1',
      customerId: 'cust-spoofed',
      rating: 4,
      comment: 'Great job',
    });

    expect(prisma.review.create).toHaveBeenCalledWith({
      data: {
        businessId: OWN_BUSINESS,
        bookingId: 'bk1',
        customerId: 'cust-real',
        cleanerId: 'cl-real',
        rating: 4,
        comment: 'Great job',
      },
    });
    expect(created.customerId).toBe('cust-real');
  });
});

describe('createReview — cross-tenant cleanerId', () => {
  test('rejects an explicit cleanerId that belongs to a different business, even when the booking itself is valid', async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: 'bk1', customerId: 'cust-real' });
    // cleanerId lookup scoped by businessId finds nothing — the id is real,
    // just not one of this business's cleaners.
    prisma.cleanerProfile.findFirst.mockResolvedValue(null);

    await expect(
      service.createReview(OWN_BUSINESS, { bookingId: 'bk1', cleanerId: 'cleaner-owned-by-B', rating: 3 })
    ).rejects.toMatchObject({ status: 404 });

    expect(prisma.cleanerProfile.findFirst).toHaveBeenCalledWith({
      where: { id: 'cleaner-owned-by-B', businessId: OWN_BUSINESS },
      select: { id: true },
    });
    expect(prisma.review.create).not.toHaveBeenCalled();
  });

  test('accepts an explicit cleanerId that does belong to this business', async () => {
    prisma.booking.findFirst.mockResolvedValue({ id: 'bk1', customerId: 'cust-real' });
    prisma.cleanerProfile.findFirst.mockResolvedValue({ id: 'cl-own' });

    await service.createReview(OWN_BUSINESS, { bookingId: 'bk1', cleanerId: 'cl-own', rating: 5 });

    expect(prisma.review.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cleanerId: 'cl-own' }) })
    );
    // An explicit, valid cleanerId shouldn't trigger the inference lookup.
    expect(prisma.bookingAssignment.findFirst).not.toHaveBeenCalled();
  });
});

describe('getReview / deleteReview — already correctly scoped, guarded against regression', () => {
  test('getReview 404s for a review that belongs to a different business', async () => {
    prisma.review.findFirst.mockResolvedValue(null);
    await expect(service.getReview(OWN_BUSINESS, 'rv-owned-by-B')).rejects.toMatchObject({ status: 404 });
    expect(prisma.review.findFirst).toHaveBeenCalledWith({ where: { id: 'rv-owned-by-B', businessId: OWN_BUSINESS } });
  });

  test('deleteReview 404s (and never calls delete) for a review that belongs to a different business', async () => {
    prisma.review.findFirst.mockResolvedValue(null);
    await expect(service.deleteReview(OWN_BUSINESS, 'rv-owned-by-B')).rejects.toMatchObject({ status: 404 });
    expect(prisma.review.delete).not.toHaveBeenCalled();
  });
});
