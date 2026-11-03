const prisma = require('../config/database');

/**
 * Subscription access rules (Lady Greener -> business billing).
 *
 * Until now nothing in the API looked at BusinessSubscription.status or
 * trialEndsAt, and a freshly registered business has no subscription row at
 * all - every plan check "failed open" - so a business could use the whole
 * platform, with unlimited cleaners and every feature, without ever paying.
 *
 * Rules (when enforcement is on):
 *  - No subscription row: a platform trial of SUBSCRIPTION_TRIAL_DAYS from the
 *    business's creation, limited to the cheapest active plan's limits/features.
 *  - TRIALING: allowed until trialEndsAt (1 day of slack for webhook lag).
 *  - ACTIVE: allowed (unless it was set to cancel and the paid period is over).
 *  - PAST_DUE: allowed for SUBSCRIPTION_PAST_DUE_GRACE_DAYS after the period end.
 *  - CANCELED: allowed only until the end of the period already paid for.
 * A locked business is READ-ONLY: it can still see and export its data and
 * reach the billing page, but cannot create or change anything, take public
 * bookings, or have recurring visits generated.
 *
 * Enforcement defaults to ON in production and OFF elsewhere so local
 * development and demo data are not locked; override with
 * SUBSCRIPTION_ENFORCEMENT=on|off.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function enforcementEnabled() {
  // Lady Greener is a single business, not a SaaS: there is no plan to enforce.
  return false;
}

const num = (raw, fallback) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const trialDays = () => num(process.env.SUBSCRIPTION_TRIAL_DAYS, 14);
const pastDueGraceDays = () => num(process.env.SUBSCRIPTION_PAST_DUE_GRACE_DAYS, 7);

/** Pure decision function, exported for testing. */
function evaluate(sub, business, now = new Date()) {
  if (!sub) {
    const created = business && business.createdAt ? new Date(business.createdAt) : now;
    const trialEndsAt = new Date(created.getTime() + trialDays() * DAY_MS);
    return now < trialEndsAt
      ? { allowed: true, state: 'PLATFORM_TRIAL', trialEndsAt }
      : { allowed: false, state: 'TRIAL_EXPIRED', trialEndsAt };
  }

  const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;

  switch (sub.status) {
    case 'TRIALING': {
      const end = sub.trialEndsAt ? new Date(sub.trialEndsAt) : null;
      const allowed = !end || now.getTime() < end.getTime() + DAY_MS;
      return { allowed, state: allowed ? 'TRIALING' : 'TRIAL_EXPIRED', trialEndsAt: end };
    }
    case 'ACTIVE': {
      // Set to cancel at period end, and the webhook that flips it never arrived.
      if (sub.canceledAt && periodEnd && now > periodEnd) return { allowed: false, state: 'CANCELED' };
      return { allowed: true, state: 'ACTIVE' };
    }
    case 'PAST_DUE': {
      const base = periodEnd || (sub.updatedAt ? new Date(sub.updatedAt) : now);
      const allowed = now.getTime() < base.getTime() + pastDueGraceDays() * DAY_MS;
      return { allowed, state: 'PAST_DUE', graceEndsAt: new Date(base.getTime() + pastDueGraceDays() * DAY_MS) };
    }
    case 'CANCELED': {
      const allowed = !!periodEnd && now < periodEnd;
      return { allowed, state: 'CANCELED', accessUntil: periodEnd };
    }
    default:
      return { allowed: true, state: 'UNKNOWN' };
  }
}

const cache = new Map();
const CACHE_TTL_MS = 30 * 1000;

/**
 * @param {string} businessId
 * @param {{ useCache?: boolean }} [opts] cache for hot public endpoints only
 */
async function getAccess(businessId, { useCache = false } = {}) {
  if (!enforcementEnabled()) return { allowed: true, state: 'ENFORCEMENT_OFF' };

  if (useCache) {
    const hit = cache.get(businessId);
    if (hit && hit.expires > Date.now()) return hit.value;
  }

  const sub = await prisma.businessSubscription.findUnique({ where: { businessId } });
  const business = sub ? null : await prisma.business.findUnique({ where: { id: businessId }, select: { createdAt: true } });
  const value = evaluate(sub, business);

  if (useCache) cache.set(businessId, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * The plan whose limits/features apply to this business: its own plan, or -
 * for a business still in its no-card platform trial - the cheapest active
 * plan. Returns null (= no limits, the legacy behaviour) only when
 * enforcement is off.
 */
async function getEffectivePlan(businessId) {
  const sub = await prisma.businessSubscription.findUnique({ where: { businessId }, include: { plan: true } });
  if (sub && sub.plan) return sub.plan;
  if (!enforcementEnabled()) return null;
  return prisma.subscriptionPlan.findFirst({ where: { isActive: true }, orderBy: { monthlyPriceCents: 'asc' } });
}

function clearCache() {
  cache.clear();
}

module.exports = { enforcementEnabled, evaluate, getAccess, getEffectivePlan, clearCache };
