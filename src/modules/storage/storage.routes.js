const express = require('express');
const { body } = require('express-validator');
const controller = require('./storage.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.list);
router.post('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), [body('bookingId').notEmpty(), body('storageKey').notEmpty()], validate, controller.create);
router.delete('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.remove);

module.exports = router;
