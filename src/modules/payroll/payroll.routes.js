const express = require('express');
const { body } = require('express-validator');
const controller = require('./payroll.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness, requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'));

router.get('/compensation', controller.listCompensations);
router.put(
  '/compensation/:cleanerId',
  [body('type').isIn(['PERCENT', 'FLAT_PER_JOB', 'HOURLY']), body('value').isInt({ min: 1 })],
  validate,
  controller.setCompensation
);

router.get('/earnings', controller.listEarnings);
router.get('/summary', controller.getSummary);

router.get('/payouts', controller.listPayouts);
router.post(
  '/payouts/:cleanerId',
  [body('method').optional().isIn(['MANUAL_CASH', 'MANUAL_TRANSFER', 'OTHER']), body('reference').optional().isString()],
  validate,
  controller.createPayout
);
router.post(
  '/payouts/:id/mark-paid',
  [body('method').optional().isIn(['MANUAL_CASH', 'MANUAL_TRANSFER', 'OTHER']), body('reference').optional().isString()],
  validate,
  controller.markPayoutPaid
);
// Automated counterpart to mark-paid: actually moves money, via Stripe
// Connect, from the business's balance to the cleaner's connected account.
// Requires both sides to have completed Connect onboarding — see
// payroll.service.payViaStripe for the exact failure modes.
router.post('/payouts/:id/pay-stripe', controller.payViaStripe);

module.exports = router;
