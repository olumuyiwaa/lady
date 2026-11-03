const express = require('express');
const controller = require('./businesses.controller');
const { authenticate } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

const router = express.Router();
const { requireRole } = require('../../middleware/authenticate');

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);

// Setup checklist the dashboard uses to force new businesses through Stripe
// Connect + services + hours + service areas before treating them as fully
// live. Open to any authenticated business member (not owner/manager-only)
// since the dashboard shell checks this on every load to decide whether to
// redirect at all.
router.get('/onboarding-status', controller.getOnboardingStatus);
router.put('/', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.update);

router.get('/branding', controller.getBranding);
router.put('/branding', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.updateBranding);
router.post('/branding/upload-url', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.brandingUploadUrl);

// Stripe Connect — onboarding a business to receive job-level customer
// payments directly. Distinct from the platform's own subscription billing.
// Owner/manager only: this exposes connected-account status and can kick
// off or refresh onboarding, which is a business-financial-settings action,
// not something a cleaner account should be able to read or trigger.
router.get('/stripe-connect/status', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.getStripeConnectStatus);
router.post('/stripe-connect/onboard', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.startStripeConnectOnboarding);
router.post('/stripe-connect/refresh', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.refreshStripeConnectStatus);

router.post('/addresses', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.addAddress);
router.put('/addresses/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.updateAddress);
router.delete('/addresses/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.removeAddress);

router.get('/service-areas', controller.listServiceAreas);
router.post('/service-areas', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.createServiceArea);
router.put('/service-areas/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.updateServiceArea);
router.delete('/service-areas/:id', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.deleteServiceArea);

router.get('/hours', controller.listHours);
router.put('/hours', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.updateHours);

// Franchise / multi-location. requireRole allows SUPER_ADMIN through
// automatically; any BUSINESS_MANAGER attempt is rejected since adding or
// listing locations is an ownership-level decision, not day-to-day ops.
router.get('/locations', requireRole('BUSINESS_OWNER', 'ORG_ADMIN'), controller.listLocations);
router.post('/locations', requireRole('BUSINESS_OWNER', 'ORG_ADMIN'), controller.createLocation);

module.exports = router;

