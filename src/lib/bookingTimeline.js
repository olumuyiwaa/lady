/**
 * Customer-facing progress timeline for a booking, derived from data that is
 * already recorded (no extra tables):
 *
 *   BOOKED -> CONFIRMED -> CLEANER_ASSIGNED -> ON_THE_WAY -> ARRIVED -> COMPLETED
 *
 * Each step is { key, at, state } where state is 'done' | 'current' | 'upcoming'.
 * A cancelled booking returns the steps reached so far plus a final CANCELLED
 * step. `at` is null when a step is known to have happened but its time was
 * never recorded (for example bookings confirmed automatically).
 */

const STEP_ORDER = ['BOOKED', 'CONFIRMED', 'CLEANER_ASSIGNED', 'ON_THE_WAY', 'ARRIVED', 'COMPLETED'];

function earliest(dates) {
  const valid = dates.filter(Boolean).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return new Date(Math.min(...valid.map((d) => d.getTime())));
}

function latest(dates) {
  const valid = dates.filter(Boolean).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime()));
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

/**
 * @param {object} booking      { status, createdAt, updatedAt }
 * @param {Array}  assignments  [{ assignedAt, onMyWayAt, checkedInAt, checkedOutAt }]
 * @param {object} [opts]       { confirmedAt } time of the BOOKING_CONFIRMED audit entry, if any
 */
function buildTimeline(booking, assignments = [], opts = {}) {
  const status = booking.status;
  const cancelled = status === 'CANCELLED';
  const completed = status === 'COMPLETED';
  const inProgress = status === 'IN_PROGRESS';

  const assigned = assignments.length > 0;
  const onMyWayAt = earliest(assignments.map((a) => a.onMyWayAt));
  const arrivedAt = earliest(assignments.map((a) => a.checkedInAt));
  const finishedAt = latest(assignments.map((a) => a.checkedOutAt));

  const reached = {
    BOOKED: true,
    CONFIRMED: status !== 'REQUESTED',
    CLEANER_ASSIGNED: assigned || inProgress || completed,
    ON_THE_WAY: !!onMyWayAt || !!arrivedAt || inProgress || completed,
    ARRIVED: !!arrivedAt || inProgress || completed,
    COMPLETED: completed,
  };
  if (cancelled) {
    // Only what genuinely happened before the cancellation.
    reached.CONFIRMED = !!opts.confirmedAt || assigned;
    reached.CLEANER_ASSIGNED = assigned;
    reached.ON_THE_WAY = !!onMyWayAt || !!arrivedAt;
    reached.ARRIVED = !!arrivedAt;
    reached.COMPLETED = false;
  }

  const times = {
    BOOKED: booking.createdAt || null,
    CONFIRMED: opts.confirmedAt || null,
    CLEANER_ASSIGNED: earliest(assignments.map((a) => a.assignedAt)),
    ON_THE_WAY: onMyWayAt,
    ARRIVED: arrivedAt,
    COMPLETED: finishedAt || (completed ? booking.updatedAt || null : null),
  };

  const steps = [];
  let currentAssigned = false;
  for (const key of STEP_ORDER) {
    if (cancelled && !reached[key]) continue;
    let state;
    if (reached[key]) state = 'done';
    else if (!cancelled && !currentAssigned) {
      state = 'current';
      currentAssigned = true;
    } else state = 'upcoming';
    steps.push({ key, at: reached[key] ? times[key] : null, state });
  }

  if (cancelled) {
    steps.push({ key: 'CANCELLED', at: booking.updatedAt || null, state: 'done' });
  }

  const current = cancelled
    ? 'CANCELLED'
    : (steps.find((s) => s.state === 'current') || steps[steps.length - 1]).key;

  return { steps, current };
}

module.exports = { buildTimeline, STEP_ORDER };
