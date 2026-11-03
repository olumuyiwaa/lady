const { getEffectivePlan } = require('./subscriptionAccess');
const { error } = require('../utils/response');

/**
 * Reads a boolean flag out of the business's active SubscriptionPlan.features
 * JSON (e.g. { autoDispatch: true, customDomain: false, reportExports: true }).
 *
 * A business with no subscription row is treated as being on the cheapest
 * plan (see lib/subscriptionAccess.js) instead of getting every feature for
 * free. Fails open only when enforcement is off, or when the key isn't
 * present in the plan's features JSON: the intent is to gate *known* tier
 * differences, not to lock everything down by default.
 */
async function hasPlanFeature(businessId, featureKey) {
  // Own plan, or - for a business still in its no-card platform trial - the
  // cheapest plan. null only when subscription enforcement is off.
  const plan = await getEffectivePlan(businessId);
  if (!plan) return true;

  const features = plan.features || {};
  if (!(featureKey in features)) return true;
  return features[featureKey] !== false;
}

/** Express middleware form of hasPlanFeature, for gating a whole route. */
function requirePlanFeature(featureKey, label) {
  return async (req, res, next) => {
    try {
      const allowed = await hasPlanFeature(req.businessId, featureKey);
      if (!allowed) {
        return error(res, 402, `${label || featureKey} isn't included in your current plan. Upgrade to use it.`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { hasPlanFeature, requirePlanFeature };
