/**
 * Business timezones matter here: a business in Europe/Amsterdam setting "9:00
 * AM every Monday" means 9am Netherlands time, not 9am on whatever server the API
 * happens to run on. These helpers use Intl.DateTimeFormat (built into
 * Node's ICU, no extra dependency) to convert between a timezone's wall
 * clock and the UTC instant Prisma actually stores.
 */

function getZonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month), // 1-12
    day: Number(parts.day),
    hour: parts.hour === '24' ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Minutes such that localTime = utcTime + offset, for the given instant. */
function getTimezoneOffsetMinutes(date, timeZone) {
  const p = getZonedParts(date, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUTC - date.getTime()) / 60000;
}

/**
 * Converts a wall-clock date/time in `timeZone` (month is 1-12) to the
 * actual UTC Date instant. Handles month/day overflow naturally via
 * Date.UTC's normalization (e.g. day 32 rolls into next month).
 */
function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offsetMinutes = getTimezoneOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offsetMinutes * 60000);
}

/**
 * First future occurrence of `dayOfWeek` (0=Sun..6=Sat) at `startTime`
 * ("HH:MM"), evaluated in the business's timezone rather than the server's.
 */
function computeInitialRunDate(dayOfWeek, startTime, timeZone = 'UTC') {
  const [hh, mm] = (startTime || '09:00').split(':').map(Number);
  const now = new Date();
  const nowParts = getZonedParts(now, timeZone);
  const todayLocalWeekday = new Date(nowParts.year, nowParts.month - 1, nowParts.day).getDay();

  let daysUntilTarget = (dayOfWeek - todayLocalWeekday + 7) % 7;
  let candidate = zonedWallTimeToUtc(nowParts.year, nowParts.month, nowParts.day + daysUntilTarget, hh, mm || 0, timeZone);

  if (daysUntilTarget === 0 && candidate <= now) {
    // today's slot already passed in the business's local time — push a week
    candidate = zonedWallTimeToUtc(nowParts.year, nowParts.month, nowParts.day + 7, hh, mm || 0, timeZone);
  }
  return candidate;
}

/**
 * Advances `fromDate` by the given frequency, re-anchored to the same
 * wall-clock startTime in the business's timezone — protects against DST
 * drift slowly shifting a schedule's local time over weeks/months.
 */
function advanceRunDate(fromDate, frequency, startTime, timeZone = 'UTC') {
  const [hh, mm] = (startTime || '09:00').split(':').map(Number);
  const parts = getZonedParts(fromDate, timeZone);
  let dayOffset = 7;
  if (frequency === 'BIWEEKLY') dayOffset = 14;
  if (frequency === 'MONTHLY') {
    // Same calendar day next month, clamped to that month's last day. The old
    // setMonth(+1) overflowed: Jan 31 -> "Feb 31" -> Mar 3.
    const lastDayNextMonth = new Date(Date.UTC(parts.year, parts.month + 1, 0)).getUTCDate();
    const day = Math.min(parts.day, lastDayNextMonth);
    return zonedWallTimeToUtc(parts.year, parts.month + 1, day, hh, mm || 0, timeZone);
  }
  return zonedWallTimeToUtc(parts.year, parts.month, parts.day + dayOffset, hh, mm || 0, timeZone);
}

/** True for an IANA zone name the runtime knows ("Europe/Amsterdam"). An invalid one makes every date calculation for that business throw. */
function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

module.exports = { isValidTimeZone, computeInitialRunDate, advanceRunDate, getZonedParts, zonedWallTimeToUtc, getTimezoneOffsetMinutes };
