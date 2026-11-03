const express = require('express');
const { body } = require('express-validator');
const controller = require('./reviews.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.list);
router.post('/', [body('bookingId').notEmpty(), body('rating').isInt({ min: 1, max: 5 })], validate, controller.create);
router.get('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.get);
router.delete('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.remove);

module.exports = router;
