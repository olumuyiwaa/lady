const express = require('express');
const { body } = require('express-validator');
const controller = require('./referrals.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness, requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'));

router.get('/settings', controller.getSettings);
router.put(
  '/settings',
  [
    body('enabled').optional().isBoolean(),
    body('discountCents').optional().isInt({ min: 0, max: 50000 }),
    body('rewardCents').optional().isInt({ min: 0, max: 50000 }),
    body('rewardValidDays').optional().isInt({ min: 1, max: 730 }),
    body('holdDays').optional().isInt({ min: 0, max: 60 }),
    body('minBookingCents').optional().isInt({ min: 0, max: 1000000 }),
  ],
  validate,
  controller.updateSettings
);
router.get('/stats', controller.stats);
router.post('/rewards/:couponId/cancel', controller.cancelReward);
router.post('/:bookingId/forfeit', controller.forfeit);
router.get('/', controller.list);

module.exports = router;
