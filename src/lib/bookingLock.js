const prisma = require('../config/database');

/**
 * Serialises booking creation per business.
 *
 * The public flow was: check spare capacity (quote) -> create the booking, with
 * nothing in between, so simultaneous requests for the last free slot all
 * passed the check and the slot was oversold. This runs `fn` inside a
 * transaction that holds a Postgres advisory lock keyed on the business; the
 * capacity check is repeated inside it, so the second request sees the first
 * one's committed booking.
 *
 * The lock is transaction-scoped (released on commit/rollback, including on a
 * crash) and only serialises bookings of the SAME business.
 *
 * Note: the capacity check inside the lock uses a second pooled connection, so
 * keep the Prisma pool comfortably larger than the number of concurrent
 * bookings you expect (connection_limit in DATABASE_URL). The timeouts below
 * make exhaustion fail fast instead of hanging.
 */
async function withBusinessLock(businessId, fn, { timeoutMs = 15000, maxWaitMs = 8000 } = {}) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'booking:' + businessId}))`;
      return fn(tx);
    },
    { timeout: timeoutMs, maxWait: maxWaitMs }
  );
}

module.exports = { withBusinessLock };
