const express = require('express');
const { body } = require('express-validator');
const controller = require('./widget.controller');
const { resolveBusinessFromHost } = require('../../middleware/resolveBusinessFromHost');
const { resolveBusinessFromSlug } = require('../../middleware/resolveBusinessFromSlug');
const { widgetLimiter, widgetSubmitLimiter } = require('../../middleware/rateLimiter');
const { requireCaptcha } = require('../../lib/captcha');
const validate = require('../../middleware/validate');
const { requireAcceptingBookings } = require('../../middleware/requireActiveSubscription');

// Public contact form on a business's site. Free-text phone (it is a reply
// detail here, not a lookup key); every field bounded so a bot cannot store 2 MB.
const contactValidators = [
  body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Please enter your name'),
  body('email').isString().trim().isLength({ max: 254 }).isEmail().withMessage('Please enter a valid email address'),
  body('phone')
    .optional({ nullable: true, checkFalsy: true })
    .isString()
    .trim()
    .matches(/^[+\d\s().-]{5,40}$/)
    .withMessage('Please enter a valid phone number'),
  body('message').isString().trim().isLength({ min: 10, max: 3000 }).withMessage('Message must be between 10 and 3000 characters'),
  // Honeypot: real visitors never see or fill this.
  body('website').optional({ nullable: true }).isString().isLength({ max: 200 }),
];

const bookingValidators = [
  body('firstName').trim().notEmpty(),
  body('lastName').trim().notEmpty(),
  body('phone').isMobilePhone('any'),
  body('email').optional().isEmail(),
  body('serviceId').notEmpty(),
  body('addressLine1').trim().notEmpty(),
  body('city').trim().notEmpty(),
  // Dutch (and most European) addresses have no state; province is optional.
  body('state').optional({ nullable: true }).isString().trim(),
  body('postalCode').optional({ nullable: true }).isString().trim().isLength({ max: 12 }),
  body('notes').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  body('specialInstructions').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  // Answers to the business's custom questions; each value is validated per question type in the service.
  body('answers').optional({ nullable: true }).isArray({ max: 40 }),
  body('rooms').optional({ nullable: true }).isInt({ min: 0, max: 50 }).toInt(),
  body('bathrooms').optional({ nullable: true }).isInt({ min: 0, max: 50 }).toInt(),
  body('sqft').optional({ nullable: true }).isInt({ min: 0, max: 100000 }).toInt(),
  body('frequency').optional({ nullable: true }).isIn(['ONE_TIME', 'WEEKLY', 'BIWEEKLY', 'MONTHLY']),
  body('scheduledStart').isISO8601(),
  body('couponCode').optional().isString(),
  body('giftCardCode').optional().isString(),
  body('referralCode').optional().isString().isLength({ max: 20 }),
];

/** Mounts the storefront/quote/slots/bookings endpoints behind whichever tenant-resolution middleware is passed in. */
function widgetRoutesFor(resolveBusiness) {
  const router = express.Router({ mergeParams: true });
  router.use(widgetLimiter, resolveBusiness);

  router.get('/storefront', controller.storefront);
  router.get('/address-lookup', controller.addressLookup);
  router.get('/service-area', controller.serviceArea);
  router.post('/quote', requireAcceptingBookings, [body('serviceId').notEmpty()], validate, controller.quote);
  router.get('/slots', requireAcceptingBookings, controller.slots);
  router.get('/gift-cards/:code', controller.giftCardBalance);
  router.post(
    '/waitlist',
    widgetSubmitLimiter,
    requireCaptcha(),
    requireAcceptingBookings,
    [
      body('desiredStart').isISO8601(),
      body('desiredEnd').isISO8601(),
      body('serviceId').optional().isString(),
      body('contactEmail').optional().isEmail(),
      body('contactPhone').optional().isMobilePhone('any'),
    ],
    validate,
    controller.joinWaitlist
  );
  router.post('/contact', widgetSubmitLimiter, requireCaptcha(), contactValidators, validate, controller.contact);
  router.post('/bookings', widgetSubmitLimiter, requireCaptcha(), requireAcceptingBookings, bookingValidators, validate, controller.submitBooking);

  return router;
}

// Host-based: business's own custom domain or a *.WIDGET_BASE_DOMAIN
// subdomain, resolved via reverse proxy. Mounted at /widget in app.js.
const hostRouter = widgetRoutesFor(resolveBusinessFromHost);

// Slug-based: works immediately with zero DNS/proxy setup, served from a
// single shared widget domain (e.g. widget.ladygreener.nl/w/:subdomain/...).
// Mounted at /widget-embed/:subdomain in app.js.
const slugRouter = express.Router({ mergeParams: true });
slugRouter.use('/', widgetRoutesFor(resolveBusinessFromSlug));

module.exports = hostRouter;
module.exports.slugRouter = slugRouter;
