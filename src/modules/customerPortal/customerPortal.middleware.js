const { verifyAccessToken } = require('../../utils/jwt');

function requireCustomerPortal(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    const err = new Error('Unauthorized');
    err.status = 401;
    return next(err);
  }
  try {
    const payload = verifyAccessToken(token);
    if (payload.scope !== 'CUSTOMER_PORTAL' || payload.aud !== 'customer-portal' || !payload.portalCustomerId) {
      const err = new Error('Invalid portal token');
      err.status = 401;
      return next(err);
    }
    if (req.businessId && payload.businessId && payload.businessId !== req.businessId) {
      const err = new Error('Token does not match this business');
      err.status = 403;
      return next(err);
    }
    req.portalCustomerId = payload.portalCustomerId;
    req.portalUserId = payload.sub;
    next();
  } catch (e) {
    const err = new Error('Invalid or expired token');
    err.status = 401;
    next(err);
  }
}

module.exports = { requireCustomerPortal };
