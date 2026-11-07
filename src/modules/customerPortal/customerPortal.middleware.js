const { verifyAccessToken } = require('../../utils/jwt');
const prisma = require('../../config/database');
const { scopeOfMember, isAdminScope } = require('../../lib/companyScope');

async function requireCustomerPortal(req, res, next) {
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
    req.portalScope = null; // the account holder: no restriction
    if (payload.portalMemberId) {
      // Read live, so switching a member off or changing their locations applies at once.
      const member = await prisma.companyMember.findFirst({
        where: { id: payload.portalMemberId, customerId: payload.portalCustomerId, isActive: true },
      });
      if (!member) {
        const err = new Error('Invalid or expired token');
        err.status = 401;
        return next(err);
      }
      req.portalScope = scopeOfMember(member);
    }
    next();
  } catch (e) {
    const err = new Error('Invalid or expired token');
    err.status = 401;
    next(err);
  }
}

/** Company-wide actions: the account holder and ADMIN members only. */
function requirePortalAdmin(req, res, next) {
  if (isAdminScope(req.portalScope)) return next();
  const err = new Error('This is only available to company admins');
  err.status = 403;
  return next(err);
}

module.exports = { requireCustomerPortal, requirePortalAdmin };
