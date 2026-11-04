const { error } = require('../utils/response');

/**
 * Attaches req.businessId for every staff/dashboard route. Tod Cleaning Services has a
 * single business, so this is the authenticated user's own business and no
 * client-supplied businessId is ever honoured (no super admin, no franchise
 * switching).
 */
async function scopeToBusiness(req, res, next) {
  if (!req.user?.businessId) {
    return error(res, 403, 'No business context');
  }
  req.businessId = req.user.businessId;
  return next();
}

module.exports = { scopeToBusiness };
