const express = require('express');
const { body } = require('express-validator');
const controller = require('./staff.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

// Owner-only: adding, re-roling, or removing teammates changes who can act
// on this business's behalf, so BUSINESS_MANAGER (who this endpoint would
// otherwise let self-escalate other managers) is deliberately excluded —
// only BUSINESS_OWNER and ORG_ADMIN manage the team roster.
router.get('/', requireRole('BUSINESS_OWNER', 'ORG_ADMIN'), controller.list);

router.post(
  '/',
  requireRole('BUSINESS_OWNER', 'ORG_ADMIN'),
  [
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('phone').optional().isMobilePhone('any'),
    body('role').isIn(['BUSINESS_MANAGER', 'ORG_ADMIN']),
  ],
  validate,
  controller.invite
);

router.put(
  '/:id/role',
  requireRole('BUSINESS_OWNER', 'ORG_ADMIN'),
  [body('role').isIn(['BUSINESS_MANAGER', 'ORG_ADMIN'])],
  validate,
  controller.updateRole
);

router.delete('/:id', requireRole('BUSINESS_OWNER', 'ORG_ADMIN'), controller.remove);

module.exports = router;
