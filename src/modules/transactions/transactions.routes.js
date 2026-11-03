const express = require('express');
const controller = require('./transactions.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const { requirePlanFeature } = require('../../lib/planFeatures');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

// Money records: same audience as the financial reports.
const financeRoles = requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER');

router.get('/', financeRoles, controller.list);
router.get('/summary', financeRoles, controller.summary);
// Exports are the "advanced reports & exports" plan feature, like the report exports.
router.get('/export', financeRoles, requirePlanFeature('reportExports', 'Transaction export'), controller.exportCsv);

module.exports = router;
