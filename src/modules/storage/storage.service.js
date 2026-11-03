const prisma = require('../../config/database');

/**
 * Photo keys are minted by the server (see the cleaner photo upload-url
 * route) under a per-tenant, per-booking prefix. Accepting an arbitrary
 * client-supplied key would let a caller attach another tenant's object to
 * their own booking and read it back through a signed URL.
 */
function assertPhotoKeyBelongsToBooking(storageKey, businessId, bookingId) {
  const prefix = `businesses/${businessId}/bookings/${bookingId}/photos/`;
  if (typeof storageKey !== 'string' || !storageKey.startsWith(prefix) || storageKey.includes('..')) {
    const err = new Error('storageKey does not belong to this booking');
    err.status = 422;
    throw err;
  }
}

async function listStorageItems(businessId) {
  // Return job photos for bookings belonging to this business
  return prisma.jobPhoto.findMany({ where: { booking: { businessId } }, orderBy: { uploadedAt: 'desc' }, take: 200 });
}

async function createStorageItem(businessId, payload) {
  // payload: { bookingId, stage, storageKey }
  const booking = await prisma.booking.findFirst({ where: { id: payload.bookingId, businessId } });
  if (!booking) {
    const err = new Error('Booking not found for this business');
    err.status = 404;
    throw err;
  }
  const { stage, storageKey } = payload;
  if (!['BEFORE', 'AFTER'].includes(stage)) {
    const err = new Error('stage must be BEFORE or AFTER');
    err.status = 422;
    throw err;
  }
  assertPhotoKeyBelongsToBooking(storageKey, businessId, booking.id);
  const created = await prisma.jobPhoto.create({ data: { bookingId: booking.id, stage, storageKey } });
  return created;
}

async function deleteStorageItem(businessId, id) {
  const p = await prisma.jobPhoto.findFirst({ where: { id }, include: { booking: true } });
  if (!p || p.booking.businessId !== businessId) {
    const err = new Error('Photo not found');
    err.status = 404;
    throw err;
  }
  await prisma.jobPhoto.delete({ where: { id } });
}

module.exports = { listStorageItems, createStorageItem, deleteStorageItem, assertPhotoKeyBelongsToBooking };
