const express = require('express');
const controller = require('./reports.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const { requirePlanFeature } = require('../../lib/planFeatures');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.list);
router.get('/kpis', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.kpis);
router.get('/revenue', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.revenue);
router.get('/revenue/export', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), requirePlanFeature('reportExports', 'Report exports'), controller.revenueExport);
router.get('/cleaner-performance', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.cleanerPerf);
router.get('/cleaner-performance/export', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), requirePlanFeature('reportExports', 'Report exports'), controller.cleanerPerfExport);
router.get('/audit-trail', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.auditTrail);

// Franchise rollup — only meaningful for a parent business, but harmless
// (empty locations array) if called on a standalone one.
router.get('/org-summary', requireRole('BUSINESS_OWNER', 'ORG_ADMIN'), controller.orgSummary);

module.exports = router;

