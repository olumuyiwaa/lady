const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { zonedWallTimeToUtc, isValidTimeZone } = require('../../utils/timezone');
const { fullName } = require('./transactions.builders');

const TYPES = ['BOOKING_PAYMENT', 'DEPOSIT', 'TIP', 'REFUND', 'DISPUTE', 'CLEANER_PAYOUT', 'SUBSCRIPTION'];
const DIRECTIONS = ['IN', 'OUT'];
const STATUSES = ['SUCCEEDED', 'PENDING', 'FAILED', 'REVERSED'];
const METHODS = ['STRIPE', 'CASH', 'BANK_TRANSFER', 'INVOICE', 'OTHER'];
const SORTS = ['occurredAt', 'amountCents'];
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const EXPORT_MAX_ROWS = 20000;
const DEFAULT_TIMEZONE = 'Europe/Amsterdam';

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ─────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────

/** Names are snapshotted onto the row so it still reads well after a rename or delete. */
async function withSnapshots(input) {
  let row = input;
  try {
    // Currency is the business's own unless the event carried one (Stripe does).
    if (!row.currency) {
      const b = await prisma.business.findUnique({ where: { id: row.businessId }, select: { currency: true } });
      row = { ...row, currency: ((b && b.currency) || 'EUR').toUpperCase() };
    }
  } catch (_) {
    row = { ...row, currency: 'EUR' };
  }
  if (row.counterpartyName) return row;
  try {
    if (row.customerId) {
      const c = await prisma.customer.findUnique({
        where: { id: row.customerId },
        select: { firstName: true, lastName: true },
      });
      if (c) return { ...row, counterpartyName: fullName(c) };
    } else if (row.cleanerId) {
      const c = await prisma.cleanerProfile.findUnique({
        where: { id: row.cleanerId },
        select: { user: { select: { firstName: true, lastName: true } } },
      });
      if (c && c.user) return { ...row, counterpartyName: fullName(c.user) };
    }
  } catch (_) {
    /* a missing name must never stop the money being recorded */
  }
  return row;
}

/**
 * Records one money event. NEVER throws: this runs after the payment, refund or
 * payout has already happened, and a failure to write the log must not turn a
 * successful payment into an error (or make Stripe retry a webhook that
 * already did its job). Failures are logged with enough detail to reconcile;
 * scripts/backfillTransactions.js is idempotent and fills any gap.
 *
 * `updateOnConflict`: for events that settle later (a dispute closing, a failed
 * subscription invoice that is retried and paid) the existing row moves to the
 * new status instead of being left as it was.
 *
 * Returns true when the event is on the log (written now or already there).
 */
async function record(row, { updateOnConflict = false } = {}) {
  try {
    if (!row || !row.businessId || !row.dedupeKey) {
      logger.warn('transaction not recorded: missing businessId or dedupeKey', { dedupeKey: row && row.dedupeKey });
      return false;
    }
    if (!Number.isInteger(row.amountCents) || row.amountCents <= 0) {
      // Not a money movement (e.g. a 0 EUR invoice). Nothing to log.
      return false;
    }
    const data = await withSnapshots(row);
    const update = updateOnConflict
      ? { status: data.status || 'SUCCEEDED', occurredAt: data.occurredAt, amountCents: data.amountCents }
      : {};
    await prisma.transaction.upsert({ where: { dedupeKey: data.dedupeKey }, create: data, update });
    return true;
  } catch (err) {
    // Two deliveries racing on the same key: the other one won, which is fine.
    if (err && err.code === 'P2002') return true;
    logger.error('transaction log write failed', {
      dedupeKey: row && row.dedupeKey,
      type: row && row.type,
      businessId: row && row.businessId,
      message: err && err.message,
    });
    return false;
  }
}

/**
 * Flips an existing row's status (e.g. a booking toggled back to UNPAID reverses
 * the "marked as paid" entry). No-op when there is no such row.
 */
async function setStatus(dedupeKey, status) {
  try {
    await prisma.transaction.updateMany({ where: { dedupeKey }, data: { status } });
    return true;
  } catch (err) {
    logger.error('transaction status update failed', { dedupeKey, status, message: err && err.message });
    return false;
  }
}

/**
 * A booking set back to UNPAID wipes its hand-recorded payments, so the matching
 * log rows are REVERSED (kept, not deleted: the history of what was recorded
 * and withdrawn is itself worth having). Stripe payments are untouched.
 */
async function reverseManualPayments(bookingId) {
  try {
    await prisma.transaction.updateMany({
      where: { bookingId, type: 'BOOKING_PAYMENT', method: { not: 'STRIPE' }, status: 'SUCCEEDED' },
      data: { status: 'REVERSED' },
    });
    return true;
  } catch (err) {
    logger.error('reversing manual payments failed', { bookingId, message: err && err.message });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────────

/** "a,b" or ["a","b"] -> validated array, or undefined when absent. */
function enumList(raw, allowed, label) {
  if (raw == null || raw === '') return undefined;
  const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((v) => String(v).trim().toUpperCase()).filter(Boolean);
  const bad = list.find((v) => !allowed.includes(v));
  if (bad) throw httpError(422, `Unknown ${label}: ${bad}`);
  return list.length ? list : undefined;
}

/** Local midnight of YYYY-MM-DD (+ offsetDays) in `timeZone`, as a UTC instant. */
function localDayStart(dateStr, timeZone, offsetDays = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // The timezone helper rolls overflow forward (2026-02-30 -> 2 March) instead of
  // failing, which would silently filter on the wrong day. Reject impossible dates.
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return zonedWallTimeToUtc(y, mo, d + offsetDays, 0, 0, timeZone);
}

/**
 * A date-only value means that whole calendar day in the business's timezone
 * (a payment at 00:30 Amsterdam time on the 1st belongs to the 1st, not to the
 * 31st in UTC). A full timestamp is used as given.
 */
function parseRange(from, to, timeZone) {
  const tz = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  const range = {};
  if (from) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(from) ? localDayStart(from, tz) : new Date(from);
    if (!d || Number.isNaN(d.getTime())) throw httpError(422, 'from is not a valid date');
    range.gte = d;
  }
  if (to) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(to);
    const d = dateOnly ? localDayStart(to, tz, 1) : new Date(to);
    if (!d || Number.isNaN(d.getTime())) throw httpError(422, 'to is not a valid date');
    // Date-only "to" is inclusive of that day, so the bound is the next local midnight.
    if (dateOnly) range.lt = d;
    else range.lte = d;
  }
  if (range.gte && (range.lt || range.lte) && range.gte > (range.lt || range.lte)) {
    throw httpError(422, 'from must not be after to');
  }
  return Object.keys(range).length ? range : undefined;
}

/**
 * Builds the Prisma `where`. `scope.businessId` is ALWAYS applied for the
 * business-facing endpoints, and filters can only narrow it: no query string
 * can widen a business's view to another business's rows.
 */
function buildWhere(scope, filters = {}, timeZone) {
  const where = {};
  if (scope.businessId) where.businessId = scope.businessId;
  else if (filters.businessId) where.businessId = String(filters.businessId);

  const type = enumList(filters.type, TYPES, 'type');
  if (type) where.type = { in: type };
  const direction = enumList(filters.direction, DIRECTIONS, 'direction');
  if (direction) where.direction = { in: direction };
  const status = enumList(filters.status, STATUSES, 'status');
  if (status) where.status = { in: status };
  const method = enumList(filters.method, METHODS, 'method');
  if (method) where.method = { in: method };

  const range = parseRange(filters.from, filters.to, timeZone);
  if (range) where.occurredAt = range;

  const q = typeof filters.q === 'string' ? filters.q.trim().slice(0, 100) : '';
  if (q) {
    where.OR = [
      { description: { contains: q, mode: 'insensitive' } },
      { counterpartyName: { contains: q, mode: 'insensitive' } },
      { reference: { contains: q, mode: 'insensitive' } },
      { bookingId: q },
      { stripePaymentIntentId: q },
      { stripeRefundId: q },
      { stripeTransferId: q },
      { stripeInvoiceId: q },
      { stripeDisputeId: q },
    ];
  }
  return where;
}

function parsePaging({ page, limit } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(MAX_LIMIT, Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT));
  return { page: p, limit: l, skip: (p - 1) * l };
}

function parseSort({ sort, order } = {}) {
  const field = SORTS.includes(sort) ? sort : 'occurredAt';
  const dir = String(order).toLowerCase() === 'asc' ? 'asc' : 'desc';
  // id as a tie-breaker keeps pages stable when many rows share a timestamp.
  return [{ [field]: dir }, { id: dir }];
}

async function timezoneFor(scope) {
  if (!scope.businessId) return DEFAULT_TIMEZONE;
  try {
    const b = await prisma.business.findUnique({ where: { id: scope.businessId }, select: { timezone: true } });
    return (b && b.timezone) || DEFAULT_TIMEZONE;
  } catch (_) {
    return DEFAULT_TIMEZONE;
  }
}

function toPublic(row) {
  return {
    id: row.id,
    type: row.type,
    direction: row.direction,
    status: row.status,
    method: row.method,
    amountCents: row.amountCents,
    currency: row.currency,
    occurredAt: row.occurredAt,
    description: row.description,
    counterpartyName: row.counterpartyName,
    reference: row.reference,
    bookingId: row.bookingId,
    stripePaymentIntentId: row.stripePaymentIntentId,
    stripeRefundId: row.stripeRefundId,
    stripeTransferId: row.stripeTransferId,
    stripeInvoiceId: row.stripeInvoiceId,
    stripeDisputeId: row.stripeDisputeId,
    // Older rows rebuilt from booking columns: their date or method is approximate.
    approximate: !!(row.backfilled && row.metadata && (row.metadata.dateApproximate || row.metadata.methodApproximate)),
    ...(row.business ? { business: { id: row.business.id, name: row.business.name, subdomain: row.business.subdomain } } : {}),
  };
}

/**
 * Paginated list. `scope` is { businessId } for a business, {} for the platform
 * admin (who may additionally filter by filters.businessId).
 */
async function list(scope, filters = {}) {
  const tz = await timezoneFor(scope);
  const where = buildWhere(scope, filters, tz);
  const { page, limit, skip } = parsePaging(filters);
  const orderBy = parseSort(filters);
  const include = scope.businessId ? undefined : { business: { select: { id: true, name: true, subdomain: true } } };

  const [rows, total] = await Promise.all([
    prisma.transaction.findMany({ where, orderBy, skip, take: limit, ...(include ? { include } : {}) }),
    prisma.transaction.count({ where }),
  ]);
  return {
    items: rows.map(toPublic),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  };
}

/**
 * Totals for the same filters as the list, per currency (a platform admin sees
 * businesses in different currencies; they must never be added together).
 * Only SUCCEEDED rows count as money moved. PENDING (an open dispute) is shown
 * separately, FAILED is just counted, REVERSED is ignored.
 */
async function summary(scope, filters = {}) {
  const tz = await timezoneFor(scope);
  const where = buildWhere(scope, filters, tz);
  const groups = await prisma.transaction.groupBy({
    by: ['currency', 'type', 'direction', 'status', 'method'],
    where,
    _sum: { amountCents: true },
    _count: { _all: true },
  });
  return foldSummary(groups, { platform: !scope.businessId });
}

function foldSummary(groups, { platform }) {
  const by = {};
  const cur = (c) => (by[c] = by[c] || {
    currency: c, inCents: 0, outCents: 0, netCents: 0, pendingOutCents: 0, count: 0, failedCount: 0, byType: {},
    ...(platform ? { subscriptionRevenueCents: 0, stripeVolumeInCents: 0, refundedCents: 0, openDisputes: 0, failedSubscriptionPayments: 0 } : {}),
  });

  for (const g of groups) {
    const row = cur(g.currency);
    const amount = (g._sum && g._sum.amountCents) || 0;
    const count = (g._count && g._count._all) || 0;
    row.count += count;
    if (g.status === 'FAILED') {
      row.failedCount += count;
      if (platform && g.type === 'SUBSCRIPTION') row.failedSubscriptionPayments += count;
      continue;
    }
    if (g.status === 'PENDING') {
      if (g.direction === 'OUT') row.pendingOutCents += amount;
      if (platform && g.type === 'DISPUTE') row.openDisputes += count;
      continue;
    }
    if (g.status !== 'SUCCEEDED') continue; // REVERSED: money did not move

    if (g.direction === 'IN') row.inCents += amount;
    else row.outCents += amount;
    const t = (row.byType[g.type] = row.byType[g.type] || { count: 0, amountCents: 0 });
    t.count += count;
    t.amountCents += amount;

    if (platform) {
      if (g.type === 'SUBSCRIPTION') row.subscriptionRevenueCents += amount;
      if (g.direction === 'IN' && g.method === 'STRIPE') row.stripeVolumeInCents += amount;
      if (g.type === 'REFUND') row.refundedCents += amount;
    }
  }
  const out = Object.values(by);
  for (const r of out) r.netCents = r.inCents - r.outCents;
  return { byCurrency: out.sort((a, b) => a.currency.localeCompare(b.currency)) };
}

// ─────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────

/** Stops a spreadsheet treating text a customer typed as a formula (=, +, -, @). */
const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/**
 * Flat rows for CSV. The amount is a number (not text) and signed by
 * direction, so a spreadsheet can sum the column to a net figure.
 */
async function exportRows(scope, filters = {}) {
  const tz = await timezoneFor(scope);
  const where = buildWhere(scope, filters, tz);
  const orderBy = parseSort(filters);
  const include = scope.businessId ? undefined : { business: { select: { name: true } } };
  const rows = await prisma.transaction.findMany({ where, orderBy, take: EXPORT_MAX_ROWS + 1, ...(include ? { include } : {}) });
  if (rows.length > EXPORT_MAX_ROWS) {
    throw httpError(422, `Too many transactions to export at once (more than ${EXPORT_MAX_ROWS}). Narrow the date range.`);
  }
  return rows.map((r) => ({
    date: r.occurredAt.toISOString(),
    ...(scope.businessId ? {} : { business: safeCell(r.business && r.business.name) }),
    type: r.type,
    direction: r.direction,
    status: r.status,
    method: r.method,
    amount: (r.direction === 'OUT' ? -r.amountCents : r.amountCents) / 100,
    currency: r.currency,
    description: safeCell(r.description),
    counterparty: safeCell(r.counterpartyName),
    reference: safeCell(r.reference),
    bookingId: r.bookingId,
    stripePaymentIntentId: r.stripePaymentIntentId,
    stripeRefundId: r.stripeRefundId,
    stripeTransferId: r.stripeTransferId,
    stripeInvoiceId: r.stripeInvoiceId,
    stripeDisputeId: r.stripeDisputeId,
    approximate: toPublic(r).approximate ? 'yes' : '',
  }));
}

module.exports = {
  record,
  setStatus,
  reverseManualPayments,
  list,
  summary,
  exportRows,
  // exported for tests
  buildWhere,
  parseRange,
  foldSummary,
  safeCell,
  TYPES,
  EXPORT_MAX_ROWS,
};
