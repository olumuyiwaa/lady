const express = require('express');
const { body } = require('express-validator');
const controller = require('./bookings.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);
router.post(
	'/',
	requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
	[body('customerId').notEmpty(), body('serviceId').notEmpty(), body('scheduledStart').notEmpty()],
	validate,
	controller.create
);

// Recurring must be registered before /:id to avoid route capture
router.post(
	'/recurring',
	requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
	[
		body('customerId').notEmpty(),
		body('serviceId').notEmpty(),
		body('customerAddressId').optional(),
		body('frequency').notEmpty(),
		body('dayOfWeek').isInt(),
		body('startTime').notEmpty(),
	],
	validate,
	controller.createRecurring
);
router.get('/recurring', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.listRecurring);
router.post('/recurring/:id/cancel', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.cancelRecurring);
router.post('/recurring/:id/pause', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.pauseRecurring);
router.post('/recurring/:id/resume', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.resumeRecurring);

router.get('/:id', controller.get);
router.put('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.update);
router.post('/:id/assign', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.assign);
router.post('/:id/confirm', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.confirm);
router.post('/:id/complete', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.complete);
router.post('/:id/mark-payment-received', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.markPaymentReceived);
router.post(
	'/:id/cancel',
	requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
	[body('reason').optional().isString()],
	validate,
	controller.cancel
);
router.post(
	'/:id/reschedule',
	requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
	[body('scheduledStart').isISO8601()],
	validate,
	controller.reschedule
);
router.post(
	'/:id/payment',
	requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
	[body('paymentStatus').notEmpty()],
	validate,
	controller.updatePayment
);
router.post(
	'/:id/payment-link',
	requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
	controller.createPaymentLink
);

module.exports = router;
