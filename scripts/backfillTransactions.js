#!/usr/bin/env node
/**
 * Fills the transaction log from money events recorded before the log existed.
 *
 *   node scripts/backfillTransactions.js            # write
 *   node scripts/backfillTransactions.js --dry-run  # count only, write nothing
 *
 * Safe to run more than once, and safe to run while the app is live: every row
 * has a deterministic dedupeKey and is inserted with skipDuplicates, so events
 * already on the log (written live since the deploy) are never duplicated or
 * overwritten. Run it after `prisma migrate deploy`.
 *
 * What it can and cannot recover (rows it writes have backfilled = true):
 *   - deposits, tips, refunds, payouts, subscription invoices: exact dates.
 *   - the main job payment: the booking stores one cumulative amount and no
 *     date, so the date is the invoice's paid date if there is one, otherwise
 *     the booking's last-updated time. Such rows carry metadata.dateApproximate.
 *   - a booking with several refunds keeps only their total and joined ids, so
 *     it becomes one approximate row.
 *   - disputes and Stripe-dashboard refunds were never stored; they appear only
 *     from the deploy onwards (the refund.created / dispute webhooks).
 */
const builders = require('../src/modules/transactions/transactions.builders');

const BATCH = 500;

async function insert(prisma, allRows, dryRun, tally, label) {
  // Same rule as the live path: a 0 EUR event (a free trial invoice) is not a money movement.
  const rows = allRows.filter((r) => Number.isInteger(r.amountCents) && r.amountCents > 0);
  if (!rows.length) return;
  tally[label].found += rows.length;
  if (dryRun) return;
  const res = await prisma.transaction.createMany({ data: rows, skipDuplicates: true });
  tally[label].inserted += res.count;
}

/** Keyset-paginates `model` by id so memory stays flat however large the table is. */
async function* batches(prisma, model, args) {
  let cursor;
  for (;;) {
    const rows = await prisma[model].findMany({
      ...args,
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) return;
    yield rows;
    cursor = rows[rows.length - 1].id;
    if (rows.length < BATCH) return;
  }
}

async function backfill({ prisma, dryRun = false, log = console.log }) {
  const tally = {
    bookings: { found: 0, inserted: 0 },
    payouts: { found: 0, inserted: 0 },
    subscriptionInvoices: { found: 0, inserted: 0 },
  };

  // Bookings: deposit, tip, job payment, refund.
  for await (const bookings of batches(prisma, 'booking', {
    where: {
      OR: [
        { depositPaidAt: { not: null } },
        { tipPaidAt: { not: null } },
        { amountPaidCents: { gt: 0 } },
        { paymentStatus: 'PAID' },
        { refundedAt: { not: null } },
      ],
    },
    include: {
      customer: { select: { firstName: true, lastName: true } },
      business: { select: { currency: true } },
      invoice: { select: { paidAt: true } },
    },
  })) {
    const rows = [];
    for (const b of bookings) {
      rows.push(...builders.rowsFromBooking({ ...b, paidAtGuess: b.invoice && b.invoice.paidAt ? b.invoice.paidAt : null }));
    }
    await insert(prisma, rows, dryRun, tally, 'bookings');
  }

  // Payouts that were actually paid.
  for await (const payouts of batches(prisma, 'payout', {
    where: { status: 'PAID', paidAt: { not: null } },
    include: {
      business: { select: { currency: true } },
      cleaner: { select: { user: { select: { firstName: true, lastName: true } } } },
    },
  })) {
    const rows = payouts.map((p) =>
      builders.rowFromPayout(p, { cleanerName: builders.fullName(p.cleaner && p.cleaner.user), currency: p.business && p.business.currency })
    );
    await insert(prisma, rows, dryRun, tally, 'payouts');
  }

  // What businesses paid Tod Cleaning Services. Only invoices that were paid, or that failed and are still open.
  for await (const invoices of batches(prisma, 'platformInvoice', {
    include: { subscription: { select: { businessId: true, business: { select: { currency: true } } } } },
  })) {
    const rows = invoices
      // paid, or failed-and-still-open. void/uncollectible are neither money moved nor a failed attempt.
      .filter((i) => i.subscription && (i.status === 'paid' || i.status === 'open'))
      .map((i) =>
        builders.rowFromPlatformInvoice(i, {
          businessId: i.subscription.businessId,
          currency: i.subscription.business && i.subscription.business.currency,
        })
      );
    await insert(prisma, rows, dryRun, tally, 'subscriptionInvoices');
  }

  log(dryRun ? 'Dry run - nothing written.' : 'Backfill complete.');
  for (const [k, v] of Object.entries(tally)) {
    log(`  ${k.padEnd(22)} found ${String(v.found).padStart(6)}   inserted ${String(v.inserted).padStart(6)}`);
  }
  return tally;
}

module.exports = { backfill };

if (require.main === module) {
  const prisma = require('../src/config/database');
  backfill({ prisma, dryRun: process.argv.includes('--dry-run') })
    .catch((err) => {
      console.error('Backfill failed:', err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
