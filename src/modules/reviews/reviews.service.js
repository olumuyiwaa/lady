const prisma = require('../../config/database');

async function listReviews(businessId, { cleanerId } = {}) {
  return prisma.review.findMany({
    where: { businessId, ...(cleanerId ? { cleanerId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

async function createReview(businessId, payload) {
  // The booking (and therefore its customer) must belong to this business —
  // without this check, business A could pass business B's bookingId and
  // have a review persisted under A that references B's customer, and
  // (via the assignment lookup below) exposes B's cleaner's identity.
  const bookingId = payload.bookingId;
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId },
    select: { id: true, customerId: true },
  });
  if (!booking) {
    const err = new Error('Booking not found for this business');
    err.status = 404;
    throw err;
  }

  // Manually-logged reviews (e.g. backfilled from an external channel) may
  // not specify which cleaner did the job — infer it the same way the
  // customer portal does, from the booking's most recent assignment,
  // unless the caller already provided one explicitly. A caller-supplied
  // cleanerId is validated against this business too, for the same reason
  // as bookingId above.
  let cleanerId = payload.cleanerId || null;
  if (cleanerId) {
    const cleaner = await prisma.cleanerProfile.findFirst({
      where: { id: cleanerId, businessId },
      select: { id: true },
    });
    if (!cleaner) {
      const err = new Error('Cleaner not found for this business');
      err.status = 404;
      throw err;
    }
  } else {
    const assignment = await prisma.bookingAssignment.findFirst({
      where: { bookingId },
      orderBy: { assignedAt: 'desc' },
    });
    cleanerId = assignment?.cleanerId || null;
  }

  // Explicit fields rather than `...payload` — customerId in particular is
  // taken from the already-validated booking, never trusted from the
  // request body, and nothing else the client sends can end up on the row.
  const created = await prisma.review.create({
    data: {
      businessId,
      bookingId,
      customerId: booking.customerId,
      cleanerId,
      rating: payload.rating,
      comment: payload.comment ?? null,
    },
  });
  return created;
}

async function getReview(businessId, id) {
  const r = await prisma.review.findFirst({ where: { id, businessId } });
  if (!r) {
    const err = new Error('Review not found');
    err.status = 404;
    throw err;
  }
  return r;
}

async function deleteReview(businessId, id) {
  await getReview(businessId, id);
  await prisma.review.delete({ where: { id } });
}

module.exports = { listReviews, createReview, getReview, deleteReview };
