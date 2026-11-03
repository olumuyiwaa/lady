/**
 * Returns a new object containing only the listed keys that are actually
 * present (not undefined) on `source`.
 *
 * Use this on every create/update path that takes a client body. Spreading
 * `req.body` into a Prisma `data` object lets a caller set columns that were
 * never meant to be client-writable — including `businessId`, which would
 * move the row into another tenant.
 */
function pick(source, keys) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}

module.exports = { pick };
