const express = require('express');
const { body } = require('express-validator');
const controller = require('./messaging.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

// Staff-only: browses every cleaner and customer in the business to start a
// new thread. Not something a cleaner account needs, and it would otherwise
// hand a cleaner the full customer directory (names, phone, email).
router.get('/recipients', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.searchRecipients);
router.get('/', controller.list);
router.post(
  '/',
  [
    body('subjectType').isIn(['CLEANER', 'CUSTOMER']).withMessage('subjectType must be CLEANER or CUSTOMER'),
    body('subjectId').notEmpty().withMessage('subjectId is required'),
  ],
  validate,
  controller.createConversation
);

router.get('/:id/messages', controller.listMessages);
router.post(
  '/:id/messages',
  [
    body('body').optional().isString(),
    body('content').optional().isString(),
    body('attachmentKey').optional().isString(),
  ],
  validate,
  controller.postMessage
);

router.patch('/messages/:messageId/read', controller.markRead);

module.exports = router;
