/**
 * Business insights computed from bookings, assignments and reviews.
 *
 * Pure: the reports service loads the rows, this turns them into numbers and a
 * handful of plain "what stands out" findings. Findings are returned as
 * { key, params } so the dashboard can word them in the user's language.
 */
const { getZonedParts } = require('../utils/timezone');

const ON_TIME_GRACE_MS = 10 * 60 * 1000;
const MIN_SAMPLE = 5; // do not call anything out from fewer observations

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const hoursOf = (b) => Math.max(0, (new Date(b.scheduledEnd) - new Date(b.scheduledStart)) / 3600000);

function localParts(date, timeZone) {
  const p = getZonedParts(new Date(date), timeZone);
  return { weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(), hour: p.hour };
}

/**
 * @param {object} i
 * @param {Array} i.bookings         non-cancelled bookings in range, with assignments[{cleanerId, checkedInAt}]
 * @param {number} i.cancelledCount  cancelled bookings in range
 * @param {Array} i.previous         non-cancelled bookings in the previous period (price only)
 * @param {number} i.previousCancelledCount
 * @param {Array} i.reviews          [{cleanerId, rating}]
 * @param {Map|object} i.firstSeen   customerId -> date of that customer's first ever booking
 * @param {Map|object} i.cleanerNames cleanerId -> name
 * @param {Date} i.from
 * @param {string} i.timeZone
 */
function buildInsights({ bookings, cancelledCount = 0, previous = [], previousCancelledCount = 0, reviews = [], firstSeen = {}, cleanerNames = {}, from, timeZone = 'Europe/Amsterdam' }) {
  const get = (m, k) => (m instanceof Map ? m.get(k) : m[k]);
  const revenueCents = bookings.reduce((a, b) => a + (b.quotedPriceCents || 0), 0);
  const prevRevenueCents = previous.reduce((a, b) => a + (b.quotedPriceCents || 0), 0);

  // demand by weekday and hour
  const byWeekday = Array.from({ length: 7 }, () => ({ bookings: 0, revenueCents: 0 }));
  const byHour = Array.from({ length: 24 }, () => 0);
  for (const b of bookings) {
    const { weekday, hour } = localParts(b.scheduledStart, timeZone);
    byWeekday[weekday].bookings += 1;
    byWeekday[weekday].revenueCents += b.quotedPriceCents || 0;
    byHour[hour] += 1;
  }

  // services
  const svc = new Map();
  for (const b of bookings) {
    const k = b.serviceName || '—';
    const s = svc.get(k) || { name: k, bookings: 0, revenueCents: 0 };
    s.bookings += 1;
    s.revenueCents += b.quotedPriceCents || 0;
    svc.set(k, s);
  }
  const services = [...svc.values()].sort((a, b) => b.revenueCents - a.revenueCents);

  // customers: new vs returning in this period
  const customerIds = [...new Set(bookings.map((b) => b.customerId))];
  const fromMs = from ? new Date(from).getTime() : 0;
  const newCustomers = customerIds.filter((id) => {
    const first = get(firstSeen, id);
    return first && new Date(first).getTime() >= fromMs;
  }).length;
  const returningCustomers = customerIds.length - newCustomers;

  // cleaners
  const ratingBy = new Map();
  for (const r of reviews) {
    if (!r.cleanerId) continue;
    const x = ratingBy.get(r.cleanerId) || { sum: 0, n: 0 };
    x.sum += r.rating;
    x.n += 1;
    ratingBy.set(r.cleanerId, x);
  }
  const cl = new Map();
  for (const b of bookings) {
    const n = (b.assignments || []).length || 0;
    for (const a of b.assignments || []) {
      const c = cl.get(a.cleanerId) || { cleanerId: a.cleanerId, jobs: 0, hours: 0, revenueCents: 0, arrivals: 0, onTime: 0 };
      c.jobs += 1;
      c.hours += hoursOf(b) / 1; // each cleaner is on site for the whole visit
      c.revenueCents += Math.round((b.quotedPriceCents || 0) / n);
      if (a.checkedInAt) {
        c.arrivals += 1;
        if (new Date(a.checkedInAt).getTime() <= new Date(b.scheduledStart).getTime() + ON_TIME_GRACE_MS) c.onTime += 1;
      }
      cl.set(a.cleanerId, c);
    }
  }
  const cleaners = [...cl.values()]
    .map((c) => {
      const r = ratingBy.get(c.cleanerId);
      return {
        cleanerId: c.cleanerId,
        name: get(cleanerNames, c.cleanerId) || null,
        jobs: c.jobs,
        hours: round1(c.hours),
        revenueCents: c.revenueCents,
        avgRating: r ? round1(r.sum / r.n) : null,
        ratings: r ? r.n : 0,
        onTimeRate: pct(c.onTime, c.arrivals),
        arrivals: c.arrivals,
      };
    })
    .sort((a, b) => b.revenueCents - a.revenueCents);

  const unassigned = bookings.filter((b) => !(b.assignments || []).length).length;
  const recurring = bookings.filter((b) => b.recurringScheduleId).length;
  const totalAttempts = bookings.length + cancelledCount;
  const cancelRate = pct(cancelledCount, totalAttempts);
  const prevCancelRate = pct(previousCancelledCount, previous.length + previousCancelledCount);

  const out = {
    bookings: bookings.length,
    revenueCents,
    previous: { bookings: previous.length, revenueCents: prevRevenueCents },
    revenueChangePct: prevRevenueCents > 0 ? round1(((revenueCents - prevRevenueCents) / prevRevenueCents) * 100) : null,
    avgBookingCents: bookings.length ? Math.round(revenueCents / bookings.length) : 0,
    cancelledCount,
    cancelRate,
    customers: { total: customerIds.length, new: newCustomers, returning: returningCustomers, returningRate: pct(returningCustomers, customerIds.length) },
    recurringShare: pct(recurring, bookings.length),
    unassigned,
    byWeekday,
    byHour,
    services,
    cleaners,
  };
  out.findings = findings(out, prevCancelRate);
  return out;
}

function findings(d, prevCancelRate) {
  const f = [];
  const busy = d.byWeekday.map((w, i) => ({ i, n: w.bookings }));
  const total = busy.reduce((a, b) => a + b.n, 0);
  if (total >= MIN_SAMPLE * 2) {
    const sorted = [...busy].sort((a, b) => b.n - a.n);
    f.push({ key: 'BUSIEST_WEEKDAY', params: { weekday: sorted[0].i, share: pct(sorted[0].n, total) } });
    const open = busy.filter((w) => w.i >= 1 && w.i <= 5).sort((a, b) => a.n - b.n)[0]; // quietest working day
    if (open && open.n < (total / 7) * 0.6) f.push({ key: 'QUIET_WEEKDAY', params: { weekday: open.i, bookings: open.n } });
  }
  if (d.revenueChangePct != null && Math.abs(d.revenueChangePct) >= 10) {
    f.push({ key: d.revenueChangePct > 0 ? 'REVENUE_UP' : 'REVENUE_DOWN', params: { pct: Math.abs(d.revenueChangePct) } });
  }
  if (d.cancelRate != null && d.cancelledCount >= 3 && prevCancelRate != null && d.cancelRate - prevCancelRate >= 5) {
    f.push({ key: 'CANCELLATIONS_UP', params: { rate: d.cancelRate, previous: prevCancelRate } });
  }
  if (d.customers.total >= MIN_SAMPLE && d.customers.returningRate != null) {
    f.push({ key: d.customers.returningRate >= 50 ? 'REPEAT_STRONG' : 'REPEAT_WEAK', params: { rate: d.customers.returningRate } });
  }
  if (d.services.length > 1 && d.revenueCents > 0 && d.services[0].revenueCents / d.revenueCents >= 0.6) {
    f.push({ key: 'SERVICE_CONCENTRATION', params: { name: d.services[0].name, share: pct(d.services[0].revenueCents, d.revenueCents) } });
  }
  const low = d.cleaners.filter((c) => c.avgRating != null && c.ratings >= 3 && c.avgRating < 4);
  for (const c of low.slice(0, 2)) f.push({ key: 'LOW_RATED_CLEANER', params: { name: c.name, rating: c.avgRating } });
  const late = d.cleaners.filter((c) => c.onTimeRate != null && c.arrivals >= MIN_SAMPLE && c.onTimeRate < 80);
  for (const c of late.slice(0, 2)) f.push({ key: 'LATE_CLEANER', params: { name: c.name, rate: c.onTimeRate } });
  if (d.unassigned > 0) f.push({ key: 'UNASSIGNED', params: { count: d.unassigned } });
  return f;
}

module.exports = { buildInsights, MIN_SAMPLE };
