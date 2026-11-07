/**
 * Cleaner time off, manager side.
 *   GET  /leave?status=&cleanerId=&from=&to=
 *   POST /leave                  { cleanerId, type?, startDate, endDate, reason? }  record leave (approved at once)
 *   POST /leave/:id/approve      { note? }  -> { leave, conflicts[] } conflicts = jobs to reassign
 *   POST /leave/:id/reject       { note? }
 *   POST /leave/:id/cancel
 * Cleaners use /cleaners/me/leave (see cleanerSelf.routes.js).
 */
const express = require('express');
const { body } = require('express-validator');
const controller = require('./leave.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();
router.use(authenticate, scopeToBusiness, requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'));

const dates = [body('startDate').matches(/^\d{4}-\d{2}-\d{2}$/), body('endDate').matches(/^\d{4}-\d{2}-\d{2}$/)];

router.get('/', controller.list);
router.post('/', [body('cleanerId').notEmpty(), ...dates], validate, controller.record);
router.post('/:id/approve', controller.approve);
router.post('/:id/reject', controller.reject);
router.post('/:id/cancel', controller.cancel);

module.exports = router;
