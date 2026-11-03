/**
 * Cleaner-facing booking routes — self-service, scoped to the caller's own
 * assigned jobs only.
 *
 * Mounted in src/routes/index.js as:
 *   router.use('/cleaner/bookings', require('../modules/bookings/cleanerBookings.routes'));
 *
 * Full contract (see also cleanerSelf.routes.js for /cleaner/me,
 * /cleaner/availability, /cleaner/documents):
 *   GET  /cleaner/bookings/my?from=&to=&status=
 *   GET  /cleaner/bookings/:id
 *   POST /cleaner/bookings/:id/check-in   { lat?, lng? }
 *   POST /cleaner/bookings/:id/start
 *   POST /cleaner/bookings/:id/complete  { lat?, lng?, notes? }
 *   POST /cleaner/bookings/:id/on-my-way
 *   POST /cleaner/bookings/:id/photos/upload-url  { stage, contentType?, filename? }
 *   POST /cleaner/bookings/:id/photos             { stage, storageKey }
 */

const express = require('express');
const { body } = require('express-validator');
const prisma = require('../../config/database');
const { authenticate } = require('../../middleware/authenticate');
const { requireActiveCleaner } = require('../../middleware/requireActiveCleaner');
const validate = require('../../middleware/validate');
const { success } = require('../../utils/response');
const bookingsService = require('./bookings.service');
const cleanersService = require('../cleaners/cleaners.service');
const { assertPhotoKeyBelongsToBooking } = require('../storage/storage.service');

// A cleaner needs to know who they are visiting and how to reach them on the
// day — not the customer's email, referral code or internal notes.
const CLEANER_VISIBLE_CUSTOMER = { select: { id: true, firstName: true, lastName: true, phone: true } };

const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const router = express.Router();

router.use(authenticate, requireActiveCleaner);

/**
 * GET /bookings/my
 * List jobs assigned to this cleaner.
 */
router.get('/my', async (req, res, next) => {
  try {
    const { from, to, status } = req.query;
    const VALID_STATUSES = ['REQUESTED', 'CONFIRMED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
    if (status && !VALID_STATUSES.includes(status)) {
      const err = new Error('Invalid status filter');
      err.status = 422;
      throw err;
    }
    for (const [label, value] of [['from', from], ['to', to]]) {
      if (value && Number.isNaN(new Date(value).getTime())) {
        const err = new Error(`Invalid ${label} date`);
        err.status = 422;
        throw err;
      }
    }
    const where = {
      assignments: { some: { cleanerId: req.cleaner.id } },
      businessId: req.cleaner.businessId,
    };
    if (status) where.status = status;
    if (from || to) {
      where.scheduledStart = {};
      if (from) where.scheduledStart.gte = new Date(from);
      if (to) where.scheduledStart.lte = new Date(to);
    }

    const bookings = await prisma.booking.findMany({
      where,
      include: {
        customer: CLEANER_VISIBLE_CUSTOMER,
        service: true,
        assignments: {
          where: { cleanerId: req.cleaner.id },
        },
        checklist: true,
      },
      orderBy: { scheduledStart: 'asc' },
      take: 100,
    });

    return success(res, 200, bookings);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /bookings/:id
 * Job detail — only if this cleaner is assigned.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const booking = await prisma.booking.findFirst({
      where: {
        id: req.params.id,
        businessId: req.cleaner.businessId,
        assignments: { some: { cleanerId: req.cleaner.id } },
      },
      include: {
        customer: CLEANER_VISIBLE_CUSTOMER,
        service: { include: { addOns: true } },
        assignments: { where: { cleanerId: req.cleaner.id } },
        checklist: true,
        photos: true,
      },
    });
    if (!booking) {
      const err = new Error('Booking not found or not assigned to you');
      err.status = 404;
      throw err;
    }
    return success(res, 200, booking);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /bookings/:id/check-in
 * Body: { lat?, lng? }
 * Resolves assignment for this cleaner and calls clockIn.
 */
router.post(
  '/:id/check-in',
  [body('lat').optional().isFloat(), body('lng').optional().isFloat()],
  validate,
  async (req, res, next) => {
    try {
      const assignment = await prisma.bookingAssignment.findFirst({
        where: { bookingId: req.params.id, cleanerId: req.cleaner.id },
      });
      if (!assignment) {
        const err = new Error('You are not assigned to this booking');
        err.status = 403;
        throw err;
      }

      const result = await cleanersService.clockIn(
        req.cleaner.businessId,
        req.cleaner.id,
        assignment.id,
        req.user.id,
        { lat: req.body.lat, lng: req.body.lng }
      );
      return success(res, 200, result, 'Checked in');
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /bookings/:id/start
 * Alias for check-in when the app separates "arrive" vs "start".
 * If already checked in, just ensures status is IN_PROGRESS.
 */
router.post('/:id/start', async (req, res, next) => {
  try {
    const assignment = await prisma.bookingAssignment.findFirst({
      where: { bookingId: req.params.id, cleanerId: req.cleaner.id },
      include: { booking: true },
    });
    if (!assignment) {
      const err = new Error('You are not assigned to this booking');
      err.status = 403;
      throw err;
    }

    // Starting a finished or cancelled job used to flip it back to
    // IN_PROGRESS.
    if (['COMPLETED', 'CANCELLED'].includes(assignment.booking.status)) {
      const err = new Error(`This booking is already ${assignment.booking.status.toLowerCase()}`);
      err.status = 409;
      throw err;
    }

    if (!assignment.checkedInAt) {
      const result = await cleanersService.clockIn(
        req.cleaner.businessId,
        req.cleaner.id,
        assignment.id,
        req.user.id,
        { lat: req.body?.lat, lng: req.body?.lng }
      );
      return success(res, 200, result, 'Started');
    }

    if (assignment.booking.status !== 'IN_PROGRESS') {
      await prisma.booking.update({
        where: { id: req.params.id },
        data: { status: 'IN_PROGRESS' },
      });
    }

    return success(res, 200, assignment, 'Already started');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /bookings/:id/complete
 * Body: { lat?, lng?, notes? }
 */
router.post(
  '/:id/complete',
  [body('lat').optional().isFloat(), body('lng').optional().isFloat(), body('notes').optional().isString()],
  validate,
  async (req, res, next) => {
    try {
      const updated = await bookingsService.completeBookingByCleaner(req.params.id, req.user.id, {
        lat: req.body.lat,
        lng: req.body.lng,
        notes: req.body.notes,
      });
      return success(res, 200, updated, 'Booking completed');
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /bookings/:id/on-my-way
 * Sends an SMS/email to the customer letting them know the cleaner is
 * headed over. No body required — this is a one-tap action in the app.
 */
router.post('/:id/on-my-way', async (req, res, next) => {
  try {
    const assignment = await prisma.bookingAssignment.findFirst({
      where: { bookingId: req.params.id, cleanerId: req.cleaner.id },
      include: { booking: { include: { customer: true, business: true } } },
    });
    if (!assignment) {
      const err = new Error('You are not assigned to this booking');
      err.status = 403;
      throw err;
    }
    if (assignment.checkedInAt) {
      const err = new Error("This job is already checked in — 'on my way' no longer applies.");
      err.status = 409;
      throw err;
    }

    const notificationsService = require('../notifications/notifications.service');
    await notificationsService.notifyOnMyWay(assignment.booking.business, assignment.booking, assignment.booking.customer);

    const updated = await prisma.bookingAssignment.update({
      where: { id: assignment.id },
      data: { onMyWayAt: new Date() },
    });
    return success(res, 200, updated, 'Customer notified');
  } catch (err) {
    next(err);
  }
});

/**
 * POST /bookings/:id/photos/upload-url
 * Body: { stage: 'BEFORE' | 'AFTER', contentType?, filename? }
 * Step 1 of photo proof: get a presigned URL, then PUT the image bytes to
 * it directly from the app, then call POST /photos below to register it.
 */
router.post(
  '/:id/photos/upload-url',
  [
    body('stage').isIn(['BEFORE', 'AFTER']),
    body('contentType').optional().isString(),
    body('filename').optional().isString(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const assignment = await prisma.bookingAssignment.findFirst({
        where: { bookingId: req.params.id, cleanerId: req.cleaner.id },
      });
      if (!assignment) {
        const err = new Error('You are not assigned to this booking');
        err.status = 403;
        throw err;
      }
      const { getSignedUploadUrl } = require('../../config/storage');
      const contentType = req.body.contentType || 'image/jpeg';
      if (!ALLOWED_PHOTO_TYPES.includes(contentType)) {
        const err = new Error(`contentType must be one of ${ALLOWED_PHOTO_TYPES.join(', ')}`);
        err.status = 422;
        throw err;
      }
      const safeName = (req.body.filename || 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = `businesses/${req.cleaner.businessId}/bookings/${req.params.id}/photos/${req.body.stage}/${Date.now()}-${safeName}`;
      const uploadUrl = await getSignedUploadUrl(key, contentType);
      return success(res, 200, { uploadUrl, storageKey: key });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /bookings/:id/photos
 * Body: { stage: 'BEFORE' | 'AFTER', storageKey }
 * Step 2: register the photo after the upload above completes. This is
 * cleaner-accessible on purpose — the admin-only POST /storage endpoint
 * can't be used here, since the person taking before/after photos on site
 * is the cleaner, not the business owner/manager.
 */
router.post(
  '/:id/photos',
  [body('stage').isIn(['BEFORE', 'AFTER']), body('storageKey').notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const assignment = await prisma.bookingAssignment.findFirst({
        where: { bookingId: req.params.id, cleanerId: req.cleaner.id },
      });
      if (!assignment) {
        const err = new Error('You are not assigned to this booking');
        err.status = 403;
        throw err;
      }
      assertPhotoKeyBelongsToBooking(req.body.storageKey, req.cleaner.businessId, req.params.id);
      const photo = await prisma.jobPhoto.create({
        data: { bookingId: req.params.id, stage: req.body.stage, storageKey: req.body.storageKey },
      });
      return success(res, 201, photo, 'Photo saved');
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
