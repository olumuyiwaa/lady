const { getZonedParts } = require('../utils/timezone');
const prisma = require('../config/database');

/**
 * Opening-hours checks for the public booking flow.
 *
 * BusinessHours rows carry an `isClosed` flag (a new business is created with
 * Sunday closed) but nothing ever read it, so the slot list offered Sundays,
 * and quote/submit did not check opening hours at all: a customer could POST a
 * booking for 03:00 as long as a cleaner was free.
 */

const DAY = 24 * 60;

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Opening window of one row in minutes from local midnight; closes after midnight when close <= open. */
function windowOf(row) {
  const openMin = toMinutes(row.openTime);
  let closeMin = toMinutes(row.closeTime);
  if (closeMin <= openMin) closeMin += DAY;
  return { openMin, closeMin };
}

/**
 * True when [start, end) fits inside one of the business's opening windows,
 * evaluated on the business's local wall clock. Windows that run past midnight
 * (e.g. 18:00-02:00) also cover the early hours of the next calendar day.
 */
function isWithinOpeningHours(rows, start, end, timeZone) {
  const p = getZonedParts(start, timeZone);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const startMin = p.hour * 60 + p.minute;
  const duration = Math.round((end.getTime() - start.getTime()) / 60000);

  const open = (rows || []).filter((r) => !r.isClosed);

  for (const r of open.filter((x) => x.dayOfWeek === dow)) {
    const { openMin, closeMin } = windowOf(r);
    if (startMin >= openMin && startMin + duration <= closeMin) return true;
  }
  // Spill-over from yesterday's window that ends after midnight.
  for (const r of open.filter((x) => x.dayOfWeek === (dow + 6) % 7)) {
    const { openMin, closeMin } = windowOf(r);
    if (closeMin > DAY && startMin + DAY >= openMin && startMin + DAY + duration <= closeMin) return true;
  }
  return false;
}

async function assertWithinBusinessHours(businessId, start, end, timeZone) {
  const rows = await prisma.businessHours.findMany({ where: { businessId } });
  if (!isWithinOpeningHours(rows, start, end, timeZone)) {
    const err = new Error('The business is closed at the requested time. Please choose one of the available slots.');
    err.status = 422;
    throw err;
  }
}

module.exports = { isWithinOpeningHours, assertWithinBusinessHours, windowOf };
