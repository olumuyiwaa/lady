const express = require('express');
const { body } = require('express-validator');
const controller = require('./customerPortal.controller');
const portalService = require('./customerPortal.service');
const { resolveBusinessFromHost } = require('../../middleware/resolveBusinessFromHost');
const { resolveBusinessFromSlug } = require('../../middleware/resolveBusinessFromSlug');
const { widgetLimiter } = require('../../middleware/rateLimiter');
const validate = require('../../middleware/validate');
const { requireCustomerPortal, requirePortalAdmin } = require('./customerPortal.middleware');

/**
 * Shared portal route tree. Tenant is resolved by the middleware passed in
 * (Host header for custom domains, or :subdomain slug for zero-DNS setup).
 */
function portalRoutesFor(resolveBusiness) {
  const router = express.Router({ mergeParams: true });
  router.use(widgetLimiter, resolveBusiness);

  // Public — one-time code by phone (SMS + email) or by email only
  const identifier = [
    body('phone').custom((value, { req }) => {
      if (String(value || '').trim() || String(req.body.email || '').trim()) return true;
      throw new Error('phone or email is required');
    }),
    body('email').optional({ values: 'falsy' }).isEmail().withMessage('email is invalid'),
  ];
  router.post('/access/request', identifier, validate, controller.requestAccess);
  router.post('/access/verify', [...identifier, body('code').notEmpty()], validate, controller.verifyAccess);

  // Authenticated portal actions
  router.use(requireCustomerPortal);

  // A branch manager may only open bookings at their own locations.
  router.param('id', async (req, res, next, id) => {
    try {
      await portalService.assertBookingInScope(req.businessId, req.portalCustomerId, id, req.portalScope);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get('/overview', controller.getOverview);
  router.get('/referral', requirePortalAdmin, controller.getReferral);
  router.get('/cleaners', requirePortalAdmin, controller.listMyCleaners);
  router.put(
    '/preferences/cleaner',
    requirePortalAdmin,
    [body('cleanerId').optional({ nullable: true }).isString()],
    validate,
    controller.setPreferredCleaner
  );

  router.put(
    '/preferences',
    requirePortalAdmin,
    [body('language').optional().isIn(['nl', 'en']), body('whatsappOptIn').optional().isBoolean({ strict: true })],
    validate,
    controller.setPreferences
  );

  router.get('/bookings', controller.listBookings);
  router.get('/bookings/:id/timeline', controller.getTimeline);
  router.get('/complaints', controller.listComplaints);
  // Business accounts only (403 otherwise, enforced in b2b.service).
  router.get('/b2b/summary', controller.b2bSummary);
  router.get('/b2b/export.csv', controller.b2bExportCsv);
  router.get('/b2b/statement/html', requirePortalAdmin, controller.b2bStatementHtml);
  router.get('/b2b/quality', controller.b2bQuality);
  router.get('/b2b/quality.pdf', controller.b2bQualityPdf);

  // Team: company admins manage who else can log in and which branches they see.
  const memberBody = [
    body('firstName').optional().isString(),
    body('lastName').optional().isString(),
    body('email').optional({ values: 'falsy' }).isEmail(),
    body('phone').optional({ values: 'falsy' }).isString(),
    body('role').optional().isIn(['ADMIN', 'BRANCH_MANAGER']),
    body('locationKeys').optional().isArray({ max: 200 }),
    body('isActive').optional().isBoolean({ strict: true }),
  ];
  router.get('/b2b/locations', requirePortalAdmin, controller.listMemberLocations);
  router.get('/b2b/members', requirePortalAdmin, controller.listMembers);
  router.post('/b2b/members', requirePortalAdmin, memberBody, validate, controller.createMember);
  router.put('/b2b/members/:memberId', requirePortalAdmin, memberBody, validate, controller.updateMember);
  router.delete('/b2b/members/:memberId', requirePortalAdmin, controller.removeMember);
  router.post(
    '/bookings/:id/complaint',
    [body('category').optional().isString(), body('description').isString().isLength({ min: 10, max: 2000 })],
    validate,
    controller.createComplaint
  );
  router.get('/bookings/:id/messages', controller.listMessages);
  router.post(
    '/bookings/:id/messages',
    [body('body').isString().trim().isLength({ min: 1, max: 1000 })],
    validate,
    controller.postMessage
  );
  router.get('/bookings/:id', controller.getBooking);
  router.get('/bookings/:id/invoice', controller.getInvoice);
  router.get('/bookings/:id/invoice/html', controller.getInvoiceHtml);
  router.post('/bookings/:id/cancel', controller.cancelBooking);
  router.post(
    '/bookings/:id/reschedule',
    [body('scheduledStart').isISO8601()],
    validate,
    controller.rescheduleBooking
  );
  router.post(
    '/bookings/:id/review',
    [body('rating').isInt({ min: 1, max: 5 })],
    validate,
    controller.leaveReview
  );
  router.post(
    '/bookings/:id/tip',
    [body('amountCents').isInt({ min: 50 })],
    validate,
    controller.tipBooking
  );

  return router;
}

// Host-based: business custom domain or *.WIDGET_BASE_DOMAIN
const hostRouter = portalRoutesFor(resolveBusinessFromHost);

// Slug-based: /portal-embed/:subdomain/... (mirrors widget-embed)
const slugRouter = express.Router({ mergeParams: true });
slugRouter.use('/', portalRoutesFor(resolveBusinessFromSlug));

module.exports = hostRouter;
module.exports.slugRouter = slugRouter;
