const prisma = require('../config/database');
const { error } = require('../utils/response');

/**
 * Resolves the ACTIVE CleanerProfile for the logged-in user and attaches it
 * as req.cleaner, plus req.businessId for anything downstream that expects
 * tenant scoping. Used by cleaner self-service routes (/cleaner/*).
 *
 * A cleaner who works for more than one business chooses a workspace at
 * login; authenticate() puts the matching profile id on req.user. That choice
 * used to be ignored here (the first active profile always won), so the
 * workspace switcher in the app was cosmetic. Now the chosen profile is used,
 * and only when the token carries no workspace does it fall back to the first
 * active profile.
 */
async function requireActiveCleaner(req, res, next) {
  try {
    const cleaner = await prisma.cleanerProfile.findFirst({
      where: {
        userId: req.user.id,
        status: 'ACTIVE',
        ...(req.user.cleanerProfileId ? { id: req.user.cleanerProfileId } : {}),
      },
      include: { business: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!cleaner) {
      return error(res, 403, 'Active cleaner profile not found');
    }
    req.cleaner = cleaner;
    req.businessId = cleaner.businessId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireActiveCleaner };
