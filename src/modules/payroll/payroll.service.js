const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const logger = require('../../config/logger');
const stripeClient = require('../../lib/stripeClient');
const transactions = require('../transactions/transactions.service');
const txRows = require('../transactions/transactions.builders');

async function getCleanerOrThrow(businessId, cleanerId) {
  const cleaner = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!cleaner) {
    const err = new Error('Cleaner not found for this business');
    err.status = 404;
    throw err;
  }
  return cleaner;
}

function validateCompensationInput(type, value) {
  const allowedTypes = ['PERCENT', 'FLAT_PER_JOB', 'HOURLY'];
  if (!allowedTypes.includes(type)) {
    const err = new Error(`type must be one of ${allowedTypes.join(', ')}`);
    err.status = 422;
    throw err;
  }
  if (!Number.isInteger(value) || value <= 0) {
    const err = new Error('value must be a positive integer');
    err.status = 422;
    throw err;
  }
  if (type === 'PERCENT' && value > 100) {
    const err = new Error('a PERCENT value cannot exceed 100');
    err.status = 422;
    throw err;
  }
}

/** Sets (or replaces) how a cleaner is paid. One rule per cleaner. */
async function setCompensation(businessId, actorUserId, cleanerId, { type, value }) {
  await getCleanerOrThrow(businessId, cleanerId);
  validateCompensationInput(type, value);

  const comp = await prisma.cleanerCompensation.upsert({
    where: { cleanerId },
    update: { type, value },
    create: { businessId, cleanerId, type, value },
  });

  await audit({
    businessId,
    actorUserId,
    action: 'CLEANER_COMPENSATION_SET',
    entityType: 'CleanerCompensation',
    entityId: comp.id,
    metadata: { cleanerId, type, value },
  });

  return comp;
}

async function listCompensations(businessId) {
  return prisma.cleanerCompensation.findMany({
    where: { businessId },
    include: { cleaner: { select: { id: true, userId: true, user: { select: { firstName: true, lastName: true, email: true } } } } },
  });
}

/**
 * Resolves each assignment's share (0-1) of a booking's PERCENT-type
 * earnings pool. Assignments with an explicit earningsSplitPercent use
 * that; the remainder of the pool (100% minus whatever explicit shares
 * already claim) is split evenly across the assignments that didn't set
 * one. For the overwhelming majority case — a single assignment — this
 * always resolves to 1 (100%), so solo bookings are completely unaffected
 * by this logic.
 */
function resolveEarningsShares(assignments) {
  const shares = new Map();
  if (assignments.length <= 1) {
    if (assignments.length === 1) shares.set(assignments[0].id, 1);
    return shares;
  }

  const explicit = assignments.filter((a) => a.earningsSplitPercent != null);
  const implicit = assignments.filter((a) => a.earningsSplitPercent == null);
  const explicitTotal = explicit.reduce((sum, a) => sum + a.earningsSplitPercent, 0);
  const remaining = Math.max(0, 100 - explicitTotal);
  const evenShare = implicit.length > 0 ? remaining / implicit.length : 0;

  for (const a of explicit) shares.set(a.id, a.earningsSplitPercent / 100);
  for (const a of implicit) shares.set(a.id, evenShare / 100);
  return shares;
}

/**
 * Computes each assigned cleaner's earning for a just-completed booking and
 * records it. Idempotent — safe to call more than once for the same
 * booking (e.g. the cleaner-complete path and an admin re-complete both
 * calling it) because of the (bookingId, cleanerId) unique constraint; a
 * repeat call is a silent no-op per cleaner rather than a duplicate charge.
 *
 * A cleaner with no CleanerCompensation row configured for them simply
 * accrues nothing — this never guesses a rate nobody set.
 */
async function computeEarningsForBooking(businessId, bookingId) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId },
    include: { assignments: true },
  });
  if (!booking || booking.assignments.length === 0) return [];

  // Only PERCENT-type comp is scaled by team size — see
  // resolveEarningsShares() and the earningsSplitPercent field comment in
  // schema.prisma for why. Without this, two cleaners each configured at,
  // say, a 50% PERCENT rate would each independently earn 50% of the job on
  // a shared booking — 100% of the job paid out in cleaner wages alone,
  // regardless of what the business actually intended to pay for a team
  // job. HOURLY and FLAT_PER_JOB are untouched: both are already
  // inherently per-person (actual hours worked; a flat stipend for
  // participating), not a cut of the job total, so team size doesn't
  // double-count them the same way.
  const earningsShareByAssignmentId = resolveEarningsShares(booking.assignments);

  const created = [];
  for (const assignment of booking.assignments) {
    try {
      const existing = await prisma.cleanerEarning.findUnique({
        where: { bookingId_cleanerId: { bookingId, cleanerId: assignment.cleanerId } },
      });
      if (existing) continue;

      const comp = await prisma.cleanerCompensation.findUnique({ where: { cleanerId: assignment.cleanerId } });
      if (!comp) continue;

      let amountCents = 0;
      if (comp.type === 'PERCENT') {
        const share = earningsShareByAssignmentId.get(assignment.id) ?? 1;
        amountCents = Math.round(((booking.quotedPriceCents || 0) * comp.value * share) / 100);
      } else if (comp.type === 'FLAT_PER_JOB') {
        amountCents = comp.value;
      } else if (comp.type === 'HOURLY') {
        if (!assignment.checkedInAt || !assignment.checkedOutAt) {
          // Can't compute a hint of a number without real clock times —
          // skip rather than fabricate a duration.
          continue;
        }
        const hours = (assignment.checkedOutAt.getTime() - assignment.checkedInAt.getTime()) / 3600000;
        amountCents = Math.round(hours * comp.value);
      }
      if (amountCents <= 0) continue;

      const earning = await prisma.cleanerEarning.create({
        data: {
          businessId,
          cleanerId: assignment.cleanerId,
          bookingId,
          amountCents,
          compensationType: comp.type,
          compensationValue: comp.value,
        },
      });
      created.push(earning);
    } catch (err) {
      // Non-fatal per cleaner — one bad row shouldn't block the booking
      // completion flow that triggered this, or the other cleaners on the
      // same job from earning correctly.
      logger.error('Failed to compute cleaner earning', { bookingId, cleanerId: assignment.cleanerId, error: err.message });
    }
  }
  return created;
}

async function listEarnings(businessId, { cleanerId, status } = {}) {
  return prisma.cleanerEarning.findMany({
    where: { businessId, ...(cleanerId ? { cleanerId } : {}), ...(status ? { status } : {}) },
    include: { booking: { select: { id: true, scheduledStart: true,scheduledEnd: true, quotedPriceCents: true } } },
    orderBy: { earnedAt: 'desc' },
  });
}

/**
 * Business-wide payroll totals for the dashboard's payroll page — without
 * this, the page only ever showed flat per-row earnings/payouts tables
 * with no aggregate anywhere, so answering "how much payroll do we
 * currently owe across the team?" meant manually adding up rows by hand.
 * Mirrors getEarningsSummaryByCleanerId's PENDING+IN_PAYOUT vs PAID split.
 */
async function getBusinessPayrollSummary(businessId) {
  const [pending, paid, pendingPayoutsTotal, cleanersWithPending] = await Promise.all([
    prisma.cleanerEarning.aggregate({ where: { businessId, status: { in: ['PENDING', 'IN_PAYOUT'] } }, _sum: { amountCents: true } }),
    prisma.cleanerEarning.aggregate({ where: { businessId, status: 'PAID' }, _sum: { amountCents: true } }),
    prisma.payout.aggregate({ where: { businessId, status: 'PENDING' }, _sum: { totalCents: true } }),
    prisma.cleanerEarning.groupBy({ by: ['cleanerId'], where: { businessId, status: 'PENDING' }, _sum: { amountCents: true } }),
  ]);

  return {
    pendingEarningsCents: pending._sum.amountCents || 0,
    lifetimePaidCents: paid._sum.amountCents || 0,
    pendingPayoutsCents: pendingPayoutsTotal._sum.totalCents || 0,
    cleanersWithPendingEarnings: cleanersWithPending.length,
  };
}


/**
 * A cleaner's own earnings summary — used by the cleaner app instead of the
 * old client-side estimate that never reflected a real payroll figure.
 *
 * Takes businessId explicitly (not derivable from cleanerId alone) so this
 * can never be pointed at another business's cleaner — a real risk now
 * that a cleaner can hold a separate CleanerProfile per business (see the
 * in-app business switcher): without this, a cleanerId that's valid in one
 * business but happens to be reused as an id elsewhere would leak that
 * other business's earnings.
 */
async function getEarningsSummaryByCleanerId(businessId, cleanerId) {
  const [pending, paid, recent, recentPayouts] = await Promise.all([
    prisma.cleanerEarning.aggregate({ where: { businessId, cleanerId, status: { in: ['PENDING', 'IN_PAYOUT'] } }, _sum: { amountCents: true } }),
    prisma.cleanerEarning.aggregate({ where: { businessId, cleanerId, status: 'PAID' }, _sum: { amountCents: true } }),
    prisma.cleanerEarning.findMany({ where: { businessId, cleanerId }, orderBy: { earnedAt: 'desc' }, take: 20 }),
    prisma.payout.findMany({ where: { businessId, cleanerId }, orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);

  return {
    pendingCents: pending._sum.amountCents || 0,
    lifetimePaidCents: paid._sum.amountCents || 0,
    recentEarnings: recent,
    recentPayouts,
  };
}

/** Same as above, resolved from a userId — for callers that only have the logged-in user, not their CleanerProfile. */
async function getMyEarningsSummary(businessId, cleanerUserId, cleanerProfileId) {
  // cleanerProfileId = the workspace the cleaner is currently in (multi-business cleaners).
  // businessId is scoped here too: without it, a cleaner active in more than
  // one business who calls this without cleanerProfileId would fall back to
  // whichever of their profiles happens to be oldest — possibly a *different*
  // business than the one their session is currently in.
  const cleaner = await prisma.cleanerProfile.findFirst({
    where: { userId: cleanerUserId, businessId, status: 'ACTIVE', ...(cleanerProfileId ? { id: cleanerProfileId } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  if (!cleaner) {
    const err = new Error('Active cleaner profile not found');
    err.status = 403;
    throw err;
  }
  return getEarningsSummaryByCleanerId(businessId, cleaner.id);
}

/**
 * Batches a cleaner's currently-PENDING earnings into a Payout the business
 * marks as paid once the money has actually moved outside Lady Greener (bank
 * transfer, cash, their own payroll run).
 */
async function createPayout(businessId, actorUserId, cleanerId, { method, reference } = {}) {
  await getCleanerOrThrow(businessId, cleanerId);

  const pending = await prisma.cleanerEarning.findMany({
    where: { businessId, cleanerId, status: 'PENDING' },
    orderBy: { earnedAt: 'asc' },
  });
  if (pending.length === 0) {
    const err = new Error('No pending earnings to pay out for this cleaner');
    err.status = 422;
    throw err;
  }

  const totalCents = pending.reduce((sum, e) => sum + e.amountCents, 0);
  const periodStart = pending[0].earnedAt;
  const periodEnd = pending[pending.length - 1].earnedAt;

  const payout = await prisma.$transaction(async (tx) => {
    const p = await tx.payout.create({
      data: {
        businessId,
        cleanerId,
        periodStart,
        periodEnd,
        totalCents,
        method: method || null,
        reference: reference || null,
        createdBy: actorUserId,
      },
    });
    await tx.cleanerEarning.updateMany({
      where: { id: { in: pending.map((e) => e.id) } },
      data: { status: 'IN_PAYOUT', payoutId: p.id },
    });
    return p;
  });

  await audit({
    businessId,
    actorUserId,
    action: 'PAYOUT_CREATED',
    entityType: 'Payout',
    entityId: payout.id,
    metadata: { cleanerId, totalCents, earningsCount: pending.length },
  });

  return payout;
}

async function markPayoutPaid(businessId, actorUserId, payoutId, { method, reference } = {}) {
  const payout = await prisma.payout.findFirst({ where: { id: payoutId, businessId } });
  if (!payout) {
    const err = new Error('Payout not found for this business');
    err.status = 404;
    throw err;
  }
  if (payout.status === 'PAID') {
    return payout; // idempotent
  }
  if (payout.status === 'CANCELED') {
    const err = new Error('Cannot mark a canceled payout as paid');
    err.status = 422;
    throw err;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.payout.update({
      where: { id: payoutId },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        method: method || payout.method,
        reference: reference || payout.reference,
      },
    });
    await tx.cleanerEarning.updateMany({ where: { payoutId }, data: { status: 'PAID' } });
    return p;
  });

  await audit({ businessId, actorUserId, action: 'PAYOUT_MARKED_PAID', entityType: 'Payout', entityId: payoutId });

  // Name and currency are resolved by the log itself (cleaner profile, business).
  await transactions.record(txRows.cleanerPayout({ payout: updated }));

  return updated;
}

async function listPayouts(businessId, { cleanerId, status } = {}) {
  return prisma.payout.findMany({
    where: { businessId, ...(cleanerId ? { cleanerId } : {}), ...(status ? { status } : {}) },
    include: {
      cleaner: {
        select: {
          id: true,
          userId: true,
          // stripePayoutsEnabled is included so the dashboard can show/hide
          // the "Pay via Stripe" action per payout without a second
          // round-trip per row.
          user: { select: { firstName: true, lastName: true, stripePayoutsEnabled: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Pays a PENDING payout by transferring funds from the business's Stripe
 * Connect balance straight to the cleaner's connected account — the
 * automated counterpart to markPayoutPaid's manual "I already sent it
 * myself" path. Requires both the business and the cleaner to have
 * completed Stripe Connect onboarding; fails with a clear 402/422 rather
 * than silently falling back to a manual record if either hasn't.
 */
async function payViaStripe(businessId, actorUserId, payoutId) {
  // Job payments are direct charges on the business's own Stripe account, so a
  // cleaner payout would have to be a Transfer created *as* that connected
  // account. Stripe only lets the platform create Transfers to connected
  // accounts, so this path is off until it has been verified end to end in
  // test mode (or replaced by separate-charges-and-transfers). Use manual
  // "mark as paid" meanwhile.
  if (String(process.env.ENABLE_STRIPE_CLEANER_PAYOUTS || '').toLowerCase() !== 'true') {
    const err = new Error('Paying cleaners through Stripe is not enabled. Mark the payout as paid once you have paid the cleaner.');
    err.status = 501;
    throw err;
  }
  const payout = await prisma.payout.findFirst({
    where: { id: payoutId, businessId },
    include: { cleaner: { include: { user: true } }, business: true },
  });
  if (!payout) {
    const err = new Error('Payout not found for this business');
    err.status = 404;
    throw err;
  }
  if (payout.status === 'PAID') {
    return payout; // idempotent — already settled, Stripe or otherwise
  }
  if (payout.status === 'CANCELED') {
    const err = new Error('Cannot pay a canceled payout');
    err.status = 422;
    throw err;
  }

  const transfer = await stripeClient.payCleanerTransfer({
    businessConnectedAccountId: payout.business.stripeConnectedAccountId,
    cleanerConnectedAccountId: payout.cleaner.user.stripeConnectedAccountId,
    amountCents: payout.totalCents,
    currency: payout.business.currency,
    payoutId: payout.id,
    description: `Lady Greener payout ${payout.id} (${payout.cleaner.user.firstName} ${payout.cleaner.user.lastName})`,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.payout.update({
      where: { id: payoutId },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        method: 'STRIPE',
        stripeTransferId: transfer.id,
      },
    });
    await tx.cleanerEarning.updateMany({ where: { payoutId }, data: { status: 'PAID' } });
    return p;
  });

  await audit({
    businessId,
    actorUserId,
    action: 'PAYOUT_PAID_VIA_STRIPE',
    entityType: 'Payout',
    entityId: payoutId,
    metadata: { stripeTransferId: transfer.id, amountCents: payout.totalCents },
  });

  await transactions.record(txRows.cleanerPayout({
    payout: updated,
    cleanerName: txRows.fullName(payout.cleaner && payout.cleaner.user),
    currency: payout.business && payout.business.currency,
  }));

  return updated;
}

module.exports = {
  setCompensation,
  listCompensations,
  computeEarningsForBooking,
  listEarnings,
  getMyEarningsSummary,
  getEarningsSummaryByCleanerId,
  getBusinessPayrollSummary,
  createPayout,
  markPayoutPaid,
  payViaStripe,
  listPayouts,
};
