/**
 * Cleaner self-service: profile, availability, and documents for the
 * logged-in cleaner's OWN record only. Never business-wide — for the
 * business's view of all its cleaners, see the admin /cleaners routes and
 * /cleaner-documents.
 *
 * Nested under the existing /cleaners resource as "my own record" (REST
 * convention: /cleaners is the collection, /cleaners/me is "this cleaner").
 * Mounted in src/routes/index.js BEFORE the admin /cleaners router, at the
 * same '/cleaners' prefix — Express falls through to the admin router for
 * anything this one doesn't handle (e.g. /cleaners/:id/offboard), so the
 * two coexist without route collisions. The one thing to watch: never add a
 * literal '/:id' route here, since 'me' would then be swallowed as an id.
 *
 * Mounted as:
 *   router.use('/cleaners', require('../modules/cleanerSelf/cleanerSelf.routes'));
 *
 * (Booking self-service — GET /cleaner/bookings/my, check-in/start/complete —
 * lives in cleanerBookings.routes.js, mounted separately at /cleaner/bookings.)
 *
 * Contract:
 *   GET  /cleaners/me
 *   PUT  /cleaners/me                        { phone?, avatarKey? }
 *   POST /cleaners/me/avatar-upload-url      { contentType?, filename? }
 *   GET  /cleaners/me/availability
 *   PUT  /cleaners/me/availability           { slots: [{ dayOfWeek, startTime, endTime }] }
 *   GET  /cleaners/me/documents
 *   POST /cleaners/me/documents/upload-url   { contentType?, filename? }
 *   POST /cleaners/me/documents              { title, storageKey, type?, mimeType?, fileSize?, expiresAt?, notes? }
 *   GET  /cleaners/me/documents/:id/download-url
 *   POST   /cleaners/me/device-token          { token, platform? }
 *   DELETE /cleaners/me/device-token          { token }
 *   GET    /cleaners/me/leave
 *   POST   /cleaners/me/leave           { type?, startDate, endDate, reason? } request time off (needs manager approval)
 *   DELETE /cleaners/me/leave/:id       withdraw a pending or approved leave
 *   POST /cleaners/me/location               { latitude, longitude } live position ping (dispatch map)
 *   GET  /cleaners/me/earnings                real payroll figures (see payroll module) — replaces the
 *                                              client-side estimate the Flutter app used to compute
 *   GET  /cleaners/me/stripe/status           Stripe Connect onboarding/payouts status
 *   POST /cleaners/me/stripe/onboarding-link  { refreshUrl?, returnUrl? } -> { url } to start/resume onboarding
 */

const express = require('express');
const { body } = require('express-validator');
const controller = require('./cleanerSelf.controller');
const { authenticate } = require('../../middleware/authenticate');
const { requireActiveCleaner } = require('../../middleware/requireActiveCleaner');
const validate = require('../../middleware/validate');
const { SELF_SERVICE_DOC_TYPES } = require('./cleanerSelf.service');

const router = express.Router();

router.use('/me', authenticate, requireActiveCleaner);

router.get('/me', controller.getProfile);
router.put(
  '/me',
  [body('phone').optional().isMobilePhone('any'), body('avatarKey').optional().isString()],
  validate,
  controller.updateProfile
);
router.post(
  '/me/avatar-upload-url',
  [body('contentType').optional().isString(), body('filename').optional().isString()],
  validate,
  controller.avatarUploadUrl
);

const leaveController = require('../leave/leave.controller');
router.get('/me/leave', leaveController.myList);
router.post(
  '/me/leave',
  [body('startDate').matches(/^\d{4}-\d{2}-\d{2}$/), body('endDate').matches(/^\d{4}-\d{2}-\d{2}$/), body('type').optional().isIn(['VACATION', 'SICK', 'PERSONAL', 'OTHER'])],
  validate,
  leaveController.myRequest
);
router.delete('/me/leave/:id', leaveController.myCancel);

router.get('/me/availability', controller.getAvailability);
router.put('/me/availability', [body('slots').isArray()], validate, controller.updateAvailability);

router.get('/me/documents', controller.listDocuments);
router.post(
  '/me/documents/upload-url',
  [body('contentType').optional().isString(), body('filename').optional().isString()],
  validate,
  controller.documentUploadUrl
);
router.post(
  '/me/documents',
  [
    body('title').trim().notEmpty(),
    body('storageKey').notEmpty(),
    body('type').optional().isIn(SELF_SERVICE_DOC_TYPES),
  ],
  validate,
  controller.createDocument
);
router.get('/me/documents/:id/download-url', controller.documentDownloadUrl);

router.post(
  '/me/device-token',
  [body('token').notEmpty(), body('platform').optional().isIn(['ios', 'android'])],
  validate,
  controller.registerDeviceToken
);
router.delete('/me/device-token', [body('token').notEmpty()], validate, controller.unregisterDeviceToken);

router.post(
  '/me/location',
  [body('latitude').isFloat({ min: -90, max: 90 }), body('longitude').isFloat({ min: -180, max: 180 })],
  validate,
  controller.updateLocation
);

router.get('/me/earnings', controller.getEarnings);

router.get('/me/stripe/status', controller.getStripeStatus);
router.post(
  '/me/stripe/onboarding-link',
  [body('refreshUrl').optional().isURL(), body('returnUrl').optional().isURL()],
  validate,
  controller.getStripeOnboardingLink
);

module.exports = router;
