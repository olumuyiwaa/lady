/**
 * "Plan the day": proposes who should take each still-unassigned job on a date
 * so total driving is as low as possible, then applies the plan on request.
 * See lib/dayPlanner.js for the method. Nothing is changed until /apply.
 */
const prisma = require('../../config/database');
const { planWithSavings } = require('../../lib/dayPlanner');
const { zonedWallTimeToUtc } = require('../../utils/timezone');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const km = (m) => Math.round(m / 100) / 10;
const name = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ') || null;
const asStop = (b) => ({ id: b.id, start: b.scheduledStart, end: b.scheduledEnd, lat: b.latitude, lng: b.longitude });

async function planForDate(businessId, dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) throw httpError(422, 'date must be a valid YYYY-MM-DD');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];

  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } });
  const tz = business?.timezone || 'Europe/Amsterdam';
  const start = zonedWallTimeToUtc(y, mo, d, 0, 0, tz);
  const end = zonedWallTimeToUtc(y, mo, d + 1, 0, 0, tz);

  const [jobs, cleaners] = await Promise.all([
    prisma.booking.findMany({
      where: {
        businessId,
        status: { notIn: ['CANCELLED', 'COMPLETED', 'IN_PROGRESS'] },
        assignments: { none: {} },
        scheduledStart: { gte: start, lt: end },
      },
      include: { customer: { select: { firstName: true, lastName: true } } },
      orderBy: { scheduledStart: 'asc' },
      take: 200,
    }),
    prisma.cleanerProfile.findMany({ where: { businessId, status: 'ACTIVE' }, include: { user: { select: { firstName: true, lastName: true } } } }),
  ]);
  if (jobs.length === 0) return { date: dateStr, jobs: 0, assignments: [], unassigned: [], totalKm: 0, naiveKm: 0, savedKm: 0 };

  const existing = await prisma.bookingAssignment.findMany({
    where: { cleanerId: { in: cleaners.map((c) => c.id) }, booking: { businessId, status: { not: 'CANCELLED' }, scheduledStart: { gte: start, lt: end } } },
    include: { booking: true },
  });
  const stopsBy = new Map(cleaners.map((c) => [c.id, []]));
  for (const a of existing) stopsBy.get(a.cleanerId)?.push(asStop(a.booking));

  // Working hours, time off and overlaps are the scheduler's job; the planner only
  // chooses among cleaners it says can take the visit.
  const scheduler = require('../../lib/scheduler');
  const availability = new Map();
  for (const j of jobs) {
    const free = await scheduler.findAvailableCleaners(businessId, j.scheduledStart, j.scheduledEnd, { maxDistanceMeters: 60000 });
    availability.set(j.id, new Set(free.map((c) => (c.cleaner || c).id)));
  }

  const plan = planWithSavings(
    cleaners.map((c) => ({ id: c.id, stops: stopsBy.get(c.id) })),
    jobs.map(asStop),
    { isAvailable: (cleanerId, jobId) => availability.get(jobId)?.has(cleanerId) }
  );

  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  const cleanerMap = new Map(cleaners.map((c) => [c.id, c]));
  const label = (j) => ({
    customerName: name(j.customer),
    address: [j.addressLine1, j.city].filter(Boolean).join(', '),
    scheduledStart: j.scheduledStart,
    scheduledEnd: j.scheduledEnd,
  });
  return {
    date: dateStr,
    jobs: jobs.length,
    assignments: plan.assignments.map((a) => ({
      bookingId: a.bookingId,
      cleanerId: a.cleanerId,
      cleanerName: name(cleanerMap.get(a.cleanerId)?.user),
      addedKm: km(a.addedMeters),
      approximate: a.approximate,
      alternatives: a.alternatives,
      ...label(jobMap.get(a.bookingId)),
    })),
    unassigned: plan.unassigned.map((u) => ({ ...u, ...label(jobMap.get(u.bookingId)) })),
    totalKm: km(plan.totalMeters),
    naiveKm: km(plan.naiveMeters),
    savedKm: km(plan.savedMeters),
  };
}

/** Applies proposed assignments one by one; each is validated by createAssignment (conflicts, status). */
async function applyPlan(businessId, assignments, actorUserId) {
  if (!Array.isArray(assignments) || assignments.length === 0) throw httpError(422, 'Nothing to apply');
  if (assignments.length > 200) throw httpError(422, 'Too many assignments');
  const { createAssignment } = require('./dispatch.service');
  const results = [];
  for (const a of assignments) {
    try {
      await createAssignment(businessId, a.bookingId, a.cleanerId, actorUserId);
      results.push({ bookingId: a.bookingId, ok: true });
    } catch (e) {
      results.push({ bookingId: a.bookingId, ok: false, error: e.message });
    }
  }
  return { applied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

module.exports = { planForDate, applyPlan };
