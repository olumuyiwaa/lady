/** Validation/normalisation of the identifiers that must appear on a Dutch invoice. */

const compact = (v) => String(v || '').replace(/[\s.\-]/g, '').toUpperCase();

/** KvK number: 8 digits. */
function normalizeKvk(value) {
  const v = compact(value);
  return /^\d{8}$/.test(v) ? v : null;
}

/** BTW-id. NL: NL + 9 digits + B + 2 digits. Other EU countries: 2 letters + 2-12 alphanumerics. */
function normalizeVatNumber(value) {
  const v = compact(value);
  if (v.startsWith('NL')) return /^NL\d{9}B\d{2}$/.test(v) ? v : null;
  return /^[A-Z]{2}[A-Z0-9]{2,12}$/.test(v) ? v : null;
}

/** IBAN with the ISO 13616 mod-97 check. */
function normalizeIban(value) {
  const v = compact(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return null;
  const rearranged = v.slice(4) + v.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1 ? v : null;
}

module.exports = { normalizeKvk, normalizeVatNumber, normalizeIban };
