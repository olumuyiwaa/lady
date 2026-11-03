#!/usr/bin/env node
/**
 * One-off backfill: rewrite Customer.phone into normalised E.164 form
 * (see src/lib/phone.js).
 *
 *   node scripts/normalize-customer-phones.js            # dry run (default)
 *   node scripts/normalize-customer-phones.js --apply    # write changes
 *
 * Safe to re-run. A row is SKIPPED, never merged, when normalising it would
 * collide with another customer of the same business (the same person is
 * already stored twice). Those are listed so the business can merge them by
 * hand - merging customers moves bookings and is not something to automate
 * blindly.
 */
const prisma = require('../src/config/database');
const { normalizePhone } = require('../src/lib/phone');

async function main() {
  const apply = process.argv.includes('--apply');
  const customers = await prisma.customer.findMany({
    select: { id: true, businessId: true, phone: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  // Phones that will exist per business once every row is normalised.
  const taken = new Map(); // `${businessId}|${phone}` -> customerId
  for (const c of customers) {
    const target = normalizePhone(c.phone);
    const key = `${c.businessId}|${target}`;
    if (!taken.has(key)) taken.set(key, c.id);
  }

  let unchanged = 0;
  const toUpdate = [];
  const conflicts = [];
  for (const c of customers) {
    const target = normalizePhone(c.phone);
    if (target === c.phone) { unchanged++; continue; }
    const owner = taken.get(`${c.businessId}|${target}`);
    if (owner && owner !== c.id) {
      conflicts.push({ id: c.id, businessId: c.businessId, phone: c.phone, target, duplicateOf: owner });
      continue;
    }
    toUpdate.push({ id: c.id, phone: target, from: c.phone });
  }

  console.log(`customers: ${customers.length}  already normalised: ${unchanged}  to update: ${toUpdate.length}  conflicts: ${conflicts.length}`);
  if (conflicts.length) {
    console.log('\nDuplicates to merge by hand (skipped):');
    for (const x of conflicts) console.log(`  ${x.id} (business ${x.businessId}) "${x.phone}" duplicates ${x.duplicateOf} as ${x.target}`);
  }
  if (!apply) {
    console.log('\nDry run - nothing written. Re-run with --apply.');
    return;
  }
  for (const u of toUpdate) {
    await prisma.customer.update({ where: { id: u.id }, data: { phone: u.phone } });
  }
  console.log(`\nUpdated ${toUpdate.length} customers.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
