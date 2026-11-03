/**
 * Booking status rules. Nothing enforced these: assignBooking, confirmBooking
 * and the dispatch board wrote a status unconditionally, so assigning a
 * cancelled booking revived it and confirming a completed one re-opened it.
 *
 *   REQUESTED -> CONFIRMED -> ASSIGNED -> IN_PROGRESS -> COMPLETED
 *   any open status -> CANCELLED;  ASSIGNED -> CONFIRMED (last cleaner removed)
 *   COMPLETED and CANCELLED are terminal.
 */
const TERMINAL = ['COMPLETED', 'CANCELLED'];

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

/** Throws 409 for a terminal booking (cannot be assigned, confirmed, edited...). */
function assertOpen(booking, action = 'change') {
  if (TERMINAL.includes(booking.status)) {
    throw conflict(`Cannot ${action} a booking that is ${booking.status.toLowerCase()}`);
  }
}

/**
 * Status after a cleaner is added: only REQUESTED/CONFIRMED move to ASSIGNED.
 * Adding a second cleaner to an ASSIGNED or IN_PROGRESS job leaves it alone
 * (previously it was reset to ASSIGNED, even mid-job).
 */
function statusAfterAssign(status) {
  return status === 'REQUESTED' || status === 'CONFIRMED' ? 'ASSIGNED' : status;
}

/** Status after a cleaner is removed: back to CONFIRMED only when nobody is left. */
function statusAfterUnassign(status, remainingAssignments) {
  return status === 'ASSIGNED' && remainingAssignments === 0 ? 'CONFIRMED' : status;
}

module.exports = { TERMINAL, assertOpen, statusAfterAssign, statusAfterUnassign };
