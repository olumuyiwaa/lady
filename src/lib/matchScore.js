/**
 * Cleaner-to-booking match score (0-100) used by dispatch.
 *
 *   proximity  35  closer is better (linear, 0 at 30 km); neutral when unknown
 *   rating     25  average review, pulled towards 4.0 until a cleaner has reviews
 *   history    20  has already cleaned for this customer (up to 3 visits);
 *                  a low rating this customer gave this cleaner is a penalty
 *   workload   10  fewer jobs that day is better
 *   preferred  10  the customer picked this cleaner in their portal
 *
 * Every component is reported back as a short machine-readable reason so the
 * dispatch screen can explain *why* someone is suggested. Looking the signals
 * up must never block dispatch: a failure just means neutral scores.
 */
const prisma = require('../config/database');
const logger = require('../config/logger');

const WEIGHTS = { proximity: 35, rating: 25, history: 20, workload: 10, preferred: 10 };
const MAX_KM = 30;
const PRIOR_RATING = 4.0;
const PRIOR_WEIGHT = 3;
const HISTORY_CAP = 3;
const WORKLOAD_CAP = 4;

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** Bayesian-smoothed average so one 5-star review does not outrank fifty 4.8s. */
function smoothedRating(sum, count) {
  return (sum + PRIOR_RATING * PRIOR_WEIGHT) / (count + PRIOR_WEIGHT);
}

/**
 * Pure.
 * @param {object} c        { distanceMeters, workload }
 * @param {object} signals  { ratingSum, ratingCount, visits, customerRating, preferred }
 * @returns {{ score:number, reasons:Array<{key:string, [k:string]:any}> }}
 */
function scoreCandidate(c = {}, signals = {}) {
  const reasons = [];
  let score = 0;

  // proximity
  if (c.distanceMeters != null && Number.isFinite(c.distanceMeters)) {
    const km = c.distanceMeters / 1000;
    score += WEIGHTS.proximity * Math.max(0, 1 - km / MAX_KM);
    if (km <= 5) reasons.push({ key: 'CLOSE', km: round1(km) });
  } else {
    score += WEIGHTS.proximity / 2;
  }

  // rating
  const count = signals.ratingCount || 0;
  const avg = smoothedRating(signals.ratingSum || 0, count);
  score += WEIGHTS.rating * ((avg - 1) / 4);
  if (count >= 3 && signals.ratingSum / count >= 4.7) {
    reasons.push({ key: 'TOP_RATED', rating: round1(signals.ratingSum / count), count });
  } else if (count >= 3 && signals.ratingSum / count < 3.5) {
    reasons.push({ key: 'LOW_RATING', rating: round1(signals.ratingSum / count), count });
  }

  // history with this customer
  const visits = signals.visits || 0;
  if (visits > 0) {
    score += WEIGHTS.history * (Math.min(visits, HISTORY_CAP) / HISTORY_CAP);
    reasons.push({ key: 'KNOWS_CUSTOMER', visits });
  }
  if (signals.customerRating != null && signals.customerRating <= 2) {
    score -= WEIGHTS.history;
    reasons.push({ key: 'CUSTOMER_LOW_RATED', rating: signals.customerRating });
  }

  // workload
  const load = Math.max(0, c.workload || 0);
  score += WEIGHTS.workload * Math.max(0, 1 - load / WORKLOAD_CAP);
  if (load === 0) reasons.push({ key: 'FREE_DAY' });

  // customer preference
  if (signals.preferred) {
    score += WEIGHTS.preferred;
    reasons.push({ key: 'PREFERRED' });
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

/**
 * Batched signal lookup for a set of cleaners.
 * Returns Map<cleanerId, { ratingSum, ratingCount, visits, customerRating }>.
 * Never throws.
 */
async function loadSignals(businessId, customerId, cleanerIds) {
  const out = new Map(cleanerIds.map((id) => [id, { ratingSum: 0, ratingCount: 0, visits: 0, customerRating: null }]));
  if (cleanerIds.length === 0) return out;

  try {
    const grouped = await prisma.review.groupBy({
      by: ['cleanerId'],
      where: { businessId, cleanerId: { in: cleanerIds } },
      _avg: { rating: true },
      _count: { rating: true },
    });
    for (const g of grouped || []) {
      const s = out.get(g.cleanerId);
      if (!s) continue;
      s.ratingCount = g._count?.rating || 0;
      s.ratingSum = (g._avg?.rating || 0) * s.ratingCount;
    }
  } catch (e) {
    logger.warn('match score: ratings lookup failed', { error: e.message });
  }

  if (customerId) {
    try {
      const visits = await prisma.bookingAssignment.groupBy({
        by: ['cleanerId'],
        where: { cleanerId: { in: cleanerIds }, booking: { businessId, customerId, status: 'COMPLETED' } },
        _count: { _all: true },
      });
      for (const g of visits || []) {
        const s = out.get(g.cleanerId);
        if (s) s.visits = g._count?._all || 0;
      }
    } catch (e) {
      logger.warn('match score: history lookup failed', { error: e.message });
    }
    try {
      const given = await prisma.review.findMany({
        where: { businessId, customerId, cleanerId: { in: cleanerIds } },
        select: { cleanerId: true, rating: true },
        orderBy: { createdAt: 'desc' },
      });
      for (const r of given || []) {
        const s = out.get(r.cleanerId);
        // most recent review wins (list is newest first)
        if (s && s.customerRating == null) s.customerRating = r.rating;
      }
    } catch (e) {
      logger.warn('match score: customer reviews lookup failed', { error: e.message });
    }
  }
  return out;
}

/**
 * Scores scheduler candidates ({cleaner, distanceMeters, etaSeconds, workload}) and
 * returns them best first, each with `matchScore` and `matchReasons`. A customer's
 * preferred cleaner is kept on top whenever they are in the list.
 */
async function rankCandidates(businessId, customerId, candidates, { preferredId = null } = {}) {
  const ids = candidates.map((c) => (c.cleaner || c).id);
  const signals = await loadSignals(businessId, customerId, ids);
  const scored = candidates.map((c) => {
    const id = (c.cleaner || c).id;
    const s = signals.get(id) || {};
    const { score, reasons } = scoreCandidate(c, { ...s, preferred: !!preferredId && id === preferredId });
    return { ...c, matchScore: score, matchReasons: reasons };
  });
  // Stable: ties keep the scheduler's travel-based order.
  return scored
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const pa = preferredId && (a.c.cleaner || a.c).id === preferredId ? 1 : 0;
      const pb = preferredId && (b.c.cleaner || b.c).id === preferredId ? 1 : 0;
      return pb - pa || b.c.matchScore - a.c.matchScore || a.i - b.i;
    })
    .map((x) => x.c);
}

module.exports = { scoreCandidate, loadSignals, rankCandidates, smoothedRating, WEIGHTS };
