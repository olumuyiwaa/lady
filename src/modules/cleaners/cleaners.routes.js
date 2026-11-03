const express = require('express');
const { body } = require('express-validator');
const controller = require('./cleaners.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

// Business-wide cleaner roster (names, emails, phones). Staff-only — a
// cleaner has their own record via /cleaners/me and no legitimate need to
// browse their coworkers' contact details.
router.get('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.list);

router.post(
  '/',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('phone').optional().isMobilePhone('any'),
  ],
  validate,
  controller.onboard
);

router.get('/:id/upcoming-jobs', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.upcomingJobs);
router.post('/:id/offboard', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.offboard);
router.post('/:id/suspend', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.suspend);
router.post('/:id/reactivate', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.reactivate);

router.put(
  '/:id/availability',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [body('slots').isArray()],
  validate,
  controller.updateAvailability
);

router.post('/:id/clock-in', [body('assignmentId').notEmpty(), body('lat').isFloat(), body('lng').isFloat()], validate, controller.clockIn);
router.post('/:id/clock-out', [body('assignmentId').notEmpty(), body('lat').isFloat(), body('lng').isFloat()], validate, controller.clockOut);

// Per-cleaner quality/throughput snapshot — average rating, review count,
// low-rating count, jobs, revenue. Staff-only; a cleaner's ratings aren't
// exposed to the cleaner themselves through this endpoint.
router.get('/:id/performance', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.performance);

module.exports = router;

