const express = require('express');
const controller = require('./dispatch.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');
const { requirePlanFeature } = require('../../lib/planFeatures');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);
// Auto-suggested dispatch — a Growth+ feature per the pricing page. Manual
// assignment (POST / with an explicit cleanerId) stays available on every
// plan; only the ranked-suggestions endpoint and the auto-pick path inside
// createAssignment (see dispatch.service.js) are gated.
router.get('/suggest', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), requirePlanFeature('autoDispatch', 'Auto-suggested dispatch'), controller.suggestCleaners);
// Basic route/travel-time awareness for one cleaner's day — same "smart
// dispatch" plan tier as /suggest above, not a separate feature flag.
router.get('/route/:cleanerId', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), requirePlanFeature('autoDispatch', 'Route awareness'), controller.getCleanerDayRoute);
// Live map: cleaner positions + jobs around now. Registered before '/:id'.
// Day planner: propose (GET) and apply (POST) a low-driving assignment of the day's open jobs.
router.get('/plan', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), requirePlanFeature('autoDispatch', 'Day planning'), controller.plan);
router.post('/plan/apply', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), requirePlanFeature('autoDispatch', 'Day planning'), controller.applyPlan);
router.get('/live', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.live);
router.post('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.createAssignment);
router.get('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.getAssignment);
router.delete('/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.removeAssignment);

module.exports = router;
