const express = require('express');
const { body } = require('express-validator');
const controller = require('./customers.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.list);
router.post(
  '/',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [body('firstName').notEmpty(), body('lastName').notEmpty(), body('phone').notEmpty()],
  validate,
  controller.create
);
router.get('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.get);
router.put('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.update);
router.delete('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.remove);

router.post(
  '/:id/addresses',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [body('line1').notEmpty(), body('city').notEmpty(), body('state').notEmpty()],
  validate,
  controller.addAddress
);
router.put('/:id/addresses/:addressId', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.updateAddress);
router.delete('/:id/addresses/:addressId', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.deleteAddress);

module.exports = router;
