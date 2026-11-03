const express = require('express');
const { body, param } = require('express-validator');
const controller = require('./supportTickets.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

// Contact details on a ticket: who a customer-facing reply is emailed to.
const contactValidators = [
  body('contactName').optional({ nullable: true }).isString().isLength({ max: 100 }),
  body('contactEmail').optional({ nullable: true, checkFalsy: true }).isString().isLength({ max: 254 }).isEmail().withMessage('contactEmail must be a valid email address'),
  body('contactPhone').optional({ nullable: true }).isString().isLength({ max: 40 }),
];

router.use(authenticate, scopeToBusiness);

router.get('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.list);
router.post(
  '/',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [
    body('subject').notEmpty().withMessage('subject is required'),
    body('description').notEmpty().withMessage('description is required'),
    body('priority').optional().isIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
    ...contactValidators,
  ],
  validate,
  controller.create
);
router.get('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.get);
router.put(
  '/:id',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [
    param('id').notEmpty(),
    body('status').optional().isIn(['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED']),
    body('priority').optional().isIn(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
    ...contactValidators,
  ],
  validate,
  controller.update
);
router.post(
  '/:id/messages',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [param('id').notEmpty(), body('body').isString().trim().isLength({ min: 1, max: 10000 }).withMessage('Reply must be between 1 and 10000 characters')],
  validate,
  controller.addMessage
);
router.delete('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.remove);

module.exports = router;
