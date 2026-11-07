const prisma = require('../config/database');
const { zonedWallTimeToUtc } = require('../utils/timezone');

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_LEAVE_DAYS = 60;

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * Turns two calendar dates ("YYYY-MM-DD", inclusive) into the instants
 * [startsAt, endsAt) in the business time zone: midnight at the start of the
 * first day, midnight at the start of the day after the last.
 */
function leaveWindow(startDate, endDate, timeZone = 'Europe/Amsterdam') {
  const a = DATE_RE.exec(startDate || '');
  const b = DATE_RE.exec(endDate || '');
  if (!a || !b) throw httpError(400, 'Dates must be in YYYY-MM-DD format');
  const [ay, am, ad] = a.slice(1).map(Number);
  const [by, bm, bd] = b.slice(1).map(Number);
  const days = (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000;
  if (!Number.isFinite(days) || days < 0) throw httpError(400, 'End date must be on or after the start date');
  if (days + 1 > MAX_LEAVE_DAYS) throw httpError(400, `Leave can span at most ${MAX_LEAVE_DAYS} days`);
  return {
    startsAt: zonedWallTimeToUtc(ay, am, ad, 0, 0, timeZone),
    endsAt: zonedWallTimeToUtc(by, bm, bd + 1, 0, 0, timeZone),
  };
}

/** Approved leave of this cleaner overlapping [start, end), or null. */
async function findLeaveConflict(cleanerId, start, end) {
  return prisma.cleanerLeave.findFirst({
    where: { cleanerId, status: 'APPROVED', startsAt: { lt: end }, endsAt: { gt: start } },
    select: { id: true, type: true, startsAt: true, endsAt: true },
  });
}

async function assertCleanerNotOnLeave(cleanerId, start, end) {
  const leave = await findLeaveConflict(cleanerId, start, end);
  if (leave) throw httpError(409, 'Cleaner is on approved leave during this time', { leaveId: leave.id });
}

/** Set of cleaner ids that have approved leave overlapping [start, end). */
async function cleanersOnLeave(cleanerIds, start, end) {
  if (!cleanerIds.length) return new Set();
  const rows = await prisma.cleanerLeave.findMany({
    where: { cleanerId: { in: cleanerIds }, status: 'APPROVED', startsAt: { lt: end }, endsAt: { gt: start } },
    select: { cleanerId: true },
  });
  return new Set(rows.map((r) => r.cleanerId));
}

module.exports = { leaveWindow, findLeaveConflict, assertCleanerNotOnLeave, cleanersOnLeave, httpError, MAX_LEAVE_DAYS };
