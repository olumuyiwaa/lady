const express = require('express');
const { param, query } = require('express-validator');
const controller = require('./waitlist.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();
router.use(authenticate, scopeToBusiness, requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'));

router.get('/', [query('status').optional().isIn(['WAITING', 'NOTIFIED', 'CONVERTED', 'EXPIRED', 'CANCELLED'])], validate, controller.list);
router.post('/:id/cancel', [param('id').notEmpty()], validate, controller.cancel);

module.exports = router;
