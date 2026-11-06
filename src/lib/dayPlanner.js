/**
 * Plans a day's unassigned jobs across cleaners to keep driving to a minimum.
 *
 * Jobs have fixed customer-chosen times, so this does not reorder anyone's day.
 * It decides WHO does each unassigned job: for every job (earliest first) each
 * available cleaner is tried at the position in their day where it fits, and the
 * cleaner for whom it adds the least driving wins. A job only fits when the
 * cleaner can actually drive from the previous stop and reach the next one on
 * time. The planner is pure (no database); dispatch.plan.js feeds it.
 *
 * Distances are straight-line x 1.3 (typical road factor) at 30 km/h city speed;
 * stops without coordinates cost nothing and are flagged as `approximate`.
 */
const { distanceMeters } = require('../utils/geo');

const ROAD_FACTOR = 1.3;
const CITY_KMH = 30;

function hasCoords(p) {
  return p && p.lat != null && p.lng != null;
}

/** Road metres between two points, or null when either has no coordinates. */
function legMeters(a, b) {
  if (!hasCoords(a) || !hasCoords(b)) return null;
  return Math.round(distanceMeters(a.lat, a.lng, b.lat, b.lng) * ROAD_FACTOR);
}

function driveSeconds(meters) {
  return meters == null ? 0 : Math.round((meters / 1000 / CITY_KMH) * 3600);
}

const ms = (d) => new Date(d).getTime();

/** Total road metres of a day's route (legs with unknown coordinates count as 0). */
function routeMeters(stops) {
  const s = [...stops].sort((a, b) => ms(a.start) - ms(b.start));
  let total = 0;
  for (let i = 0; i < s.length - 1; i++) total += legMeters(s[i], s[i + 1]) || 0;
  return total;
}

/**
 * Cheapest feasible slot for `job` in a cleaner's sorted stops.
 * @returns {{ addedMeters:number, approximate:boolean } | null}  null if it does not fit
 */
function insertionCost(stops, job) {
  const sorted = [...stops].sort((a, b) => ms(a.start) - ms(b.start));
  let prev = null;
  let next = null;
  for (const s of sorted) {
    if (ms(s.end) <= ms(job.start)) prev = s;
    else if (ms(s.start) >= ms(job.end)) {
      next = s;
      break;
    } else return null; // overlaps an existing stop
  }
  const toJob = prev ? legMeters(prev, job) : 0;
  const fromJob = next ? legMeters(job, next) : 0;
  if (prev && ms(prev.end) + driveSeconds(toJob) * 1000 > ms(job.start)) return null;
  if (next && ms(job.end) + driveSeconds(fromJob) * 1000 > ms(next.start)) return null;
  const direct = prev && next ? legMeters(prev, next) : 0;
  const approximate = (prev && toJob == null) || (next && fromJob == null);
  return { addedMeters: Math.max(0, (toJob || 0) + (fromJob || 0) - (direct || 0)), approximate: !!approximate };
}

/**
 * @param {Array<{id, stops:Array<{id,start,end,lat,lng}>}>} cleaners  existing day, per cleaner
 * @param {Array<{id,start,end,lat,lng}>} jobs                          unassigned jobs
 * @param {{ isAvailable?: (cleanerId, jobId) => boolean, strategy?: 'cheapest'|'first' }} [opts]
 */
function planDay(cleaners, jobs, { isAvailable = () => true, strategy = 'cheapest' } = {}) {
  const state = cleaners.map((c) => ({ id: c.id, stops: [...c.stops] }));
  const assignments = [];
  const unassigned = [];

  for (const job of [...jobs].sort((a, b) => ms(a.start) - ms(b.start))) {
    let best = null;
    let fitting = 0;
    for (const c of state) {
      if (!isAvailable(c.id, job.id)) continue;
      const cost = insertionCost(c.stops, job);
      if (!cost) continue;
      fitting += 1;
      const better =
        !best ||
        (strategy === 'cheapest' &&
          (cost.addedMeters < best.cost.addedMeters ||
            (cost.addedMeters === best.cost.addedMeters && c.stops.length < best.cleaner.stops.length)));
      if (better) best = { cleaner: c, cost };
      if (strategy === 'first' && best) break;
    }
    if (!best) {
      unassigned.push({ bookingId: job.id, reason: 'NO_CLEANER_FITS' });
      continue;
    }
    best.cleaner.stops.push(job);
    assignments.push({
      bookingId: job.id,
      cleanerId: best.cleaner.id,
      addedMeters: best.cost.addedMeters,
      approximate: best.cost.approximate,
      alternatives: fitting - 1,
    });
  }
  const routes = state.map((c) => ({ cleanerId: c.id, stops: c.stops.length, meters: routeMeters(c.stops) }));
  return { assignments, unassigned, routes, totalMeters: routes.reduce((a, r) => a + r.meters, 0) };
}

/** Compares the cheapest plan with simply giving each job to the first cleaner who fits. */
function planWithSavings(cleaners, jobs, opts = {}) {
  const smart = planDay(cleaners, jobs, { ...opts, strategy: 'cheapest' });
  const naive = planDay(cleaners, jobs, { ...opts, strategy: 'first' });
  return { ...smart, naiveMeters: naive.totalMeters, savedMeters: Math.max(0, naive.totalMeters - smart.totalMeters) };
}

module.exports = { planDay, planWithSavings, insertionCost, routeMeters, legMeters, driveSeconds };
