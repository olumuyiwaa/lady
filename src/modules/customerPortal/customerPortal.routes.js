const express = require('express');
const { body } = require('express-validator');
const controller = require('./customerPortal.controller');
const { resolveBusinessFromHost } = require('../../middleware/resolveBusinessFromHost');
const { resolveBusinessFromSlug } = require('../../middleware/resolveBusinessFromSlug');
const { widgetLimiter } = require('../../middleware/rateLimiter');
const validate = require('../../middleware/validate');
const { requireCustomerPortal } = require('./customerPortal.middleware');

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

  router.get('/bookings', controller.listBookings);
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
