const express = require('express');
const { body } = require('express-validator');
const controller = require('./services.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);
router.post(
	'/',
	requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
	[body('name').notEmpty(), body('basePriceCents').isInt()],
	validate,
	controller.create
);
router.get('/:id', controller.get);
router.put('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.update);
router.delete('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.remove);

router.post(
	'/:id/addons',
	requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
	[body('name').notEmpty(), body('priceCents').optional().isInt(), body('extraMinutes').optional().isInt()],
	validate,
	controller.createAddOn
);
router.put('/:id/addons/:addOnId', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.updateAddOn);
router.delete('/:id/addons/:addOnId', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.removeAddOn);

module.exports = router;
