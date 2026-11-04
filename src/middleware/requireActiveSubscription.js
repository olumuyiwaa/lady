const { error } = require('../utils/response');
const { getAccess } = require('../lib/subscriptionAccess');

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// A locked business must still be able to pay, talk to support and read
// notifications. Matched against req.baseUrl (the mount path of the router).
const EXEMPT_PREFIXES = ['/api/v1/subscriptions', '/api/v1/support-tickets', '/api/v1/notifications', '/api/v1/auth'];

/**
 * Blocks mutations for a business whose subscription has lapsed (read-only
 * mode). Must run after scopeToBusiness so req.businessId is set; scopeToBusiness
 * calls it. SUPER_ADMIN is never blocked.
 */
async function requireActiveSubscription(req, res, next) {
  try {
    if (req.user && req.user.globalRole === 'SUPER_ADMIN') return next();
    if (READ_METHODS.has(req.method)) return next();
    const base = req.baseUrl || '';
    if (EXEMPT_PREFIXES.some((p) => base.startsWith(p))) return next();

    const access = await getAccess(req.businessId);
    if (access.allowed) return next();

    return error(
      res,
      402,
      'Your Tod Cleaning Services subscription is not active. Your data is read-only until you subscribe or update your payment method.',
      { code: 'SUBSCRIPTION_REQUIRED', state: access.state }
    );
  } catch (err) {
    return next(err);
  }
}

/**
 * For the public widget: a business whose subscription lapsed stops taking
 * bookings (the storefront page itself still loads).
 */
async function requireAcceptingBookings(req, res, next) {
  try {
    const access = await getAccess(req.businessId, { useCache: true });
    if (access.allowed) return next();
    return error(res, 403, 'This business is not accepting online bookings right now.', { code: 'BOOKINGS_UNAVAILABLE' });
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireActiveSubscription, requireAcceptingBookings };
