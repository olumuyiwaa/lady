/**
 * Service-level targets for support tickets and customer complaints.
 *
 * Priority decides how fast staff should first respond and how fast the ticket
 * should be resolved. Complaints raised from the customer portal get a priority
 * from their category (damage and safety are urgent; a no-show is high).
 * Everything here is pure so it can be tested and reused by the dashboard.
 */
const HOUR = 60 * 60 * 1000;

// hours
const TARGETS = {
  URGENT: { firstResponse: 2, resolution: 24 },
  HIGH: { firstResponse: 8, resolution: 48 },
  MEDIUM: { firstResponse: 24, resolution: 120 },
  LOW: { firstResponse: 72, resolution: 240 },
};

const COMPLAINT_CATEGORIES = ['QUALITY', 'NO_SHOW', 'LATE', 'DAMAGE', 'BEHAVIOUR', 'SAFETY', 'BILLING', 'OTHER'];

const CATEGORY_PRIORITY = {
  SAFETY: 'URGENT',
  DAMAGE: 'URGENT',
  NO_SHOW: 'HIGH',
  BEHAVIOUR: 'HIGH',
  QUALITY: 'MEDIUM',
  LATE: 'MEDIUM',
  BILLING: 'MEDIUM',
  OTHER: 'LOW',
};

function priorityForComplaint(category) {
  return CATEGORY_PRIORITY[category] || 'MEDIUM';
}

function targetsFor(priority) {
  return TARGETS[priority] || TARGETS.MEDIUM;
}

/** When the ticket should be resolved by. */
function dueAtFor(priority, createdAt = new Date()) {
  return new Date(new Date(createdAt).getTime() + targetsFor(priority).resolution * HOUR);
}

/**
 * 'DONE' once resolved/closed, otherwise 'OVERDUE' past dueAt, 'AT_RISK' when
 * the first response is late or less than 20% of the window remains, else 'OK'.
 */
function slaState(ticket, now = Date.now()) {
  if (['RESOLVED', 'CLOSED'].includes(ticket.status)) return 'DONE';
  const created = new Date(ticket.createdAt).getTime();
  const due = ticket.dueAt ? new Date(ticket.dueAt).getTime() : dueAtFor(ticket.priority, ticket.createdAt).getTime();
  if (now > due) return 'OVERDUE';
  const responseDue = created + targetsFor(ticket.priority).firstResponse * HOUR;
  if (!ticket.firstResponseAt && now > responseDue) return 'AT_RISK';
  if (due - now < (due - created) * 0.2) return 'AT_RISK';
  return 'OK';
}

/** Summary numbers for a set of tickets (any statuses). */
function summarise(tickets, now = Date.now()) {
  const open = tickets.filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status));
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const hours = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / HOUR;
  const byCategory = {};
  for (const t of tickets) {
    if (t.kind !== 'COMPLAINT') continue;
    const k = t.category || 'OTHER';
    byCategory[k] = (byCategory[k] || 0) + 1;
  }
  return {
    open: open.length,
    overdue: open.filter((t) => slaState(t, now) === 'OVERDUE').length,
    atRisk: open.filter((t) => slaState(t, now) === 'AT_RISK').length,
    complaintsOpen: open.filter((t) => t.kind === 'COMPLAINT').length,
    avgFirstResponseHours: avg(tickets.filter((t) => t.firstResponseAt).map((t) => hours(t.createdAt, t.firstResponseAt))),
    avgResolutionHours: avg(tickets.filter((t) => t.resolvedAt).map((t) => hours(t.createdAt, t.resolvedAt))),
    complaintsByCategory: byCategory,
  };
}

module.exports = { TARGETS, COMPLAINT_CATEGORIES, priorityForComplaint, targetsFor, dueAtFor, slaState, summarise };
