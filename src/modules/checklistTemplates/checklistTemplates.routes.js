const express = require('express');
const { body } = require('express-validator');
const controller = require('./checklistTemplates.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);
router.post('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), [body('name').notEmpty(), body('items').notEmpty()], validate, controller.create);
router.get('/:id', controller.get);
router.put('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.update);
router.delete('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.remove);

module.exports = router;
