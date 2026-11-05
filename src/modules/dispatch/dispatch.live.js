/**
 * Live operations board: where every cleaner is and what each is doing, plus
 * the jobs around "now" (including unassigned ones), for the dispatch map.
 *
 * Cleaner state is derived from the assignment rows, never stored:
 *   ON_JOB    checked in, not yet checked out
 *   EN_ROUTE  tapped "on my way", not yet checked in
 *   NEXT_UP   has a job later in the window
 *   IDLE      nothing in the window
 * Position is CleanerProfile.lastKnown*, refreshed by clock-in/out and by the
 * cleaner app's location pings. A position older than STALE_MS is flagged
 * `stale` so the map can grey it out instead of pretending it is live.
 */
const prisma = require('../../config/database');

const STALE_MS = 30 * 60 * 1000;
const WINDOW_BEFORE_MS = 12 * 60 * 60 * 1000;
const WINDOW_AFTER_MS = 12 * 60 * 60 * 1000;

/** Pure: state of one cleaner from their assignments in the window. */
function cleanerState(assignments, now = Date.now()) {
  const open = assignments.filter((a) => !a.checkedOutAt);
  const onJob = open.find((a) => a.checkedInAt);
  if (onJob) return { state: 'ON_JOB', assignment: onJob };
  const enRoute = open.find((a) => a.onMyWayAt);
  if (enRoute) return { state: 'EN_ROUTE', assignment: enRoute };
  const upcoming = open
    .filter((a) => new Date(a.booking.scheduledEnd).getTime() >= now)
    .sort((a, b) => new Date(a.booking.scheduledStart) - new Date(b.booking.scheduledStart))[0];
  if (upcoming) return { state: 'NEXT_UP', assignment: upcoming };
  return { state: 'IDLE', assignment: null };
}

function jobSummary(b) {
  return {
    bookingId: b.id,
    status: b.status,
    customerName: b.customer ? `${b.customer.firstName} ${b.customer.lastName}`.trim() : null,
    serviceName: b.service?.name || null,
    address: [b.addressLine1, b.city].filter(Boolean).join(', '),
    scheduledStart: b.scheduledStart,
    scheduledEnd: b.scheduledEnd,
    latitude: b.latitude ?? null,
    longitude: b.longitude ?? null,
  };
}

async function getLiveBoard(businessId, now = Date.now()) {
  const from = new Date(now - WINDOW_BEFORE_MS);
  const to = new Date(now + WINDOW_AFTER_MS);

  const [cleaners, bookings] = await Promise.all([
    prisma.cleanerProfile.findMany({
      where: { businessId, status: 'ACTIVE' },
      include: { user: { select: { firstName: true, lastName: true, phone: true } } },
    }),
    prisma.booking.findMany({
      where: { businessId, status: { notIn: ['CANCELLED'] }, scheduledStart: { gte: from, lte: to } },
      include: { customer: true, service: true, assignments: true },
      orderBy: { scheduledStart: 'asc' },
      take: 300,
    }),
  ]);

  const byCleaner = new Map();
  for (const b of bookings) {
    for (const a of b.assignments) {
      if (!byCleaner.has(a.cleanerId)) byCleaner.set(a.cleanerId, []);
      byCleaner.get(a.cleanerId).push({ ...a, booking: b });
    }
  }

  const cleanerRows = cleaners.map((c) => {
    const { state, assignment } = cleanerState(byCleaner.get(c.id) || [], now);
    const at = c.lastKnownAt ? new Date(c.lastKnownAt) : null;
    const hasPosition = c.lastKnownLat != null && c.lastKnownLng != null;
    return {
      id: c.id,
      name: `${c.user?.firstName || ''} ${c.user?.lastName || ''}`.trim(),
      phone: c.user?.phone || null,
      state,
      latitude: hasPosition ? c.lastKnownLat : null,
      longitude: hasPosition ? c.lastKnownLng : null,
      positionAt: at,
      stale: !at || now - at.getTime() > STALE_MS,
      job: assignment ? jobSummary(assignment.booking) : null,
    };
  });

  const jobs = bookings.map((b) => ({
    ...jobSummary(b),
    unassigned: b.assignments.length === 0,
    cleanerIds: b.assignments.map((a) => a.cleanerId),
  }));

  return { generatedAt: new Date(now), cleaners: cleanerRows, jobs };
}

module.exports = { getLiveBoard, cleanerState, STALE_MS };
