const prisma = require('../config/database');
const { error } = require('../utils/response');

/**
 * Tod Cleaning Services is one business. Public widget/portal routes always resolve to
 * that business, whatever Host header or :subdomain the request carries, so
 * existing storefront URLs keep working without any DNS or slug setup.
 */
let cached = null;
async function getSingleBusiness() {
  if (cached && cached.expires > Date.now()) return cached.value;
  const id = process.env.BUSINESS_ID;
  const value = id
    ? await prisma.business.findUnique({ where: { id } })
    : await prisma.business.findFirst({ orderBy: { createdAt: 'asc' } });
  cached = { value, expires: Date.now() + 60 * 1000 };
  return value;
}

async function resolveBusiness(req, res, next) {
  try {
    const business = await getSingleBusiness();
    if (!business || !business.isActive) return error(res, 404, 'Business is not set up yet');
    req.businessId = business.id;
    req.business = business;
    next();
  } catch (err) {
    return error(res, 500, 'Failed to resolve business');
  }
}

function clearBusinessCache() { cached = null; }

module.exports = { getSingleBusiness, resolveBusiness, clearBusinessCache };
