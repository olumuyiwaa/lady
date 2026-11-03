const express = require('express');
const controller = require('./pricing.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const { body, param } = require('express-validator');
const validate = require('../../middleware/validate');

const router = express.Router();
router.use(authenticate, scopeToBusiness);

router.get('/', requireRole('BUSINESS_OWNER','BUSINESS_MANAGER'), controller.getPricing);
router.put('/', requireRole('BUSINESS_OWNER','BUSINESS_MANAGER'), [
	body('frequencyDiscounts').optional().custom((val) => {
		if (!val) return true;
		if (typeof val === 'object') return true;
		if (typeof val === 'string') {
			try { const parsed = JSON.parse(val); return typeof parsed === 'object'; } catch (e) { return false; }
		}
		return false;
	}),
	body('perSqftCents').optional({ nullable: true }).isInt({ min: 0 }).withMessage('perSqftCents must be a non-negative integer (cents)'),
	body('perRoomCents').optional({ nullable: true }).isInt({ min: 0 }).withMessage('perRoomCents must be a non-negative integer (cents)'),
	body('depositType').optional({ nullable: true }).isIn(['PERCENT', 'AMOUNT']),
	body('depositValue').optional({ nullable: true }).isInt({ min: 0 }),
	body('cancellationWindowHours').optional({ nullable: true }).isInt({ min: 0 }),
	body('cancellationFeeType').optional({ nullable: true }).isIn(['PERCENT', 'AMOUNT']),
	body('cancellationFeeValue').optional({ nullable: true }).isInt({ min: 0 }),
], validate, controller.updatePricing);

router.get('/coupons', requireRole('BUSINESS_OWNER','BUSINESS_MANAGER'), controller.listCoupons);
router.post('/coupons', requireRole('BUSINESS_OWNER','BUSINESS_MANAGER'), [
	body('code').notEmpty().withMessage('code is required'),
	body('type').isIn(['PERCENT','AMOUNT']).withMessage('type must be PERCENT or AMOUNT'),
	body('value').isInt({ min: 0 }).withMessage('value must be integer >= 0'),
	body('appliesToServiceId').optional().isString(),
	body('expiresAt').optional().isISO8601().withMessage('expiresAt must be ISO8601 date'),
], validate, controller.createCoupon);

router.put('/coupons/:id', requireRole('BUSINESS_OWNER','BUSINESS_MANAGER'), [
	param('id').notEmpty(),
	body('code').optional().notEmpty(),
	body('type').optional().isIn(['PERCENT','AMOUNT']),
	body('value').optional().isInt({ min: 0 }),
	body('expiresAt').optional().isISO8601(),
], validate, controller.updateCoupon);

router.delete('/coupons/:id', requireRole('BUSINESS_OWNER','BUSINESS_MANAGER'), [ param('id').notEmpty() ], validate, controller.deleteCoupon);

router.get('/gift-cards', requireRole('BUSINESS_OWNER','BUSINESS_MANAGER'), controller.listGiftCards);
router.post('/gift-cards', requireRole('BUSINESS_OWNER','BUSINESS_MANAGER'), [
	body('code').optional().isString(),
	body('initialValueCents').isInt({ min: 1 }).withMessage('initialValueCents must be a positive integer'),
	body('recipientEmail').optional().isEmail(),
	body('recipientName').optional().isString(),
	body('message').optional().isString(),
	body('expiresAt').optional().isISO8601(),
], validate, controller.issueGiftCard);
router.delete('/gift-cards/:id', requireRole('BUSINESS_OWNER','BUSINESS_MANAGER'), [ param('id').notEmpty() ], validate, controller.deactivateGiftCard);

module.exports = router;
