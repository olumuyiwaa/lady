const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const { error } = require('../utils/response');

/**
 * Verifies the access token and attaches `req.user` = { id, businessId, businessRole, globalRole, cleanerProfileId }.
 * businessId/businessRole are resolved from the user's active BusinessMember or CleanerProfile row,
 * NOT trusted from the token body alone, so a revoked membership takes effect immediately.
 */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return error(res, 401, 'Missing access token');

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Customer-portal tokens are signed with the same secret. They must never
    // be usable as a staff/cleaner session, whatever user id they carry.
    if (payload.scope || payload.aud) return error(res, 401, 'Invalid or expired token');
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive) return error(res, 401, 'Invalid session');

    let businessId = null;
    let businessRole = null;
    let cleanerProfileId = null;

    if (payload.businessId) {
      const membership = await prisma.businessMember.findFirst({
        where: { businessId: payload.businessId, userId: user.id, isActive: true },
        include: { business: { select: { isActive: true } } },
      });
      if (membership && membership.business && membership.business.isActive === false) return suspended(res);
      if (membership) {
        businessId = membership.businessId;
        businessRole = membership.role;
      } else {
        const cleaner = await prisma.cleanerProfile.findFirst({
          where: { businessId: payload.businessId, userId: user.id, status: 'ACTIVE' },
          include: { business: { select: { isActive: true } } },
        });
        if (cleaner && cleaner.business && cleaner.business.isActive === false) return suspended(res);
        if (cleaner) {
          businessId = cleaner.businessId;
          businessRole = 'CLEANER';
          cleanerProfileId = cleaner.id;
        }
      }
    }

    req.user = { id: user.id, globalRole: user.globalRole, businessId, businessRole, cleanerProfileId };
    next();
  } catch (err) {
    return error(res, 401, 'Invalid or expired token');
  }
}

// Deactivating a business (super-admin) only closed the public widget: its staff
// and cleaners kept full access. Now every authenticated request is refused.
function suspended(res) {
  return res.status(403).json({
    success: false,
    message: 'This business account is suspended. Please contact support.',
    errors: { code: 'BUSINESS_SUSPENDED' },
  });
}

/** Restricts a route to one or more business-scoped roles (or SUPER_ADMIN, always allowed). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user?.globalRole === 'SUPER_ADMIN') return next();
    if (!req.user?.businessRole || !roles.includes(req.user.businessRole)) {
      return error(res, 403, 'Insufficient permissions');
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
