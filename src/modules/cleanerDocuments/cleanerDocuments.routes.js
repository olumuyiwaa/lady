const express = require('express');
const { body, param } = require('express-validator');
const controller = require('./cleanerDocuments.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const validate = require('../../middleware/validate');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.list);
router.post(
  '/upload-url',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [
    body('cleanerId').notEmpty(),
    body('contentType').optional().isString(),
    body('filename').optional().isString(),
  ],
  validate,
  controller.uploadUrl
);
router.post(
  '/',
  requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'),
  [
    body('cleanerId').notEmpty(),
    body('title').notEmpty(),
    body('storageKey').notEmpty(),
    body('type').optional().isIn(['ID_CARD', 'BACKGROUND_CHECK', 'CERTIFICATION', 'CONTRACT', 'INSURANCE', 'OTHER']),
  ],
  validate,
  controller.create
);
router.get('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.get);
router.get('/:id/download-url', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.downloadUrl);
router.delete('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), [param('id').notEmpty()], validate, controller.remove);

module.exports = router;
