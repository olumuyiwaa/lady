/**
 * Phone number normalisation.
 *
 * Customers are keyed by (businessId, phone) with an exact string match, but
 * the same person types "06 12345678", "0612345678", "+31 6 12345678" and
 * "0031612345678". Without normalisation each form is a different customer:
 * the portal says "no account" for people who have booked, and every booking
 * made in another format creates a duplicate customer.
 *
 * normalizePhone() produces E.164-style "+<digits>". Values that do not look
 * like a phone number at all (e.g. the "deleted-<id>" placeholder written when a
 * customer is anonymised) are returned untouched.
 *
 * Default country (for numbers written nationally, "06 ...") comes from
 * DEFAULT_PHONE_COUNTRY_CODE and defaults to the Netherlands (31).
 */

const PHONE_SHAPE = /^[+\d\s().\-]+$/;

function defaultCountryCode() {
  return (process.env.DEFAULT_PHONE_COUNTRY_CODE || '31').replace(/\D/g, '') || '31';
}

function normalizePhone(raw, countryCode = defaultCountryCode()) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed || !PHONE_SHAPE.test(trimmed)) return trimmed;

  // "+31 (0)6 1234 5678": the bracketed trunk zero is not part of the number.
  const withoutTrunk = trimmed.replace(/\(\s*0\s*\)/g, '');
  const digits = withoutTrunk.replace(/\D/g, '');
  if (!digits) return trimmed;

  let international;
  if (withoutTrunk.startsWith('+')) {
    international = digits;
  } else if (digits.startsWith('00')) {
    international = digits.slice(2);
  } else if (digits.startsWith('0')) {
    international = countryCode + digits.slice(1); // national format
  } else if (digits.startsWith(countryCode) && digits.length >= 10) {
    international = digits; // "31612345678" - plus sign left off
  } else if (digits.length <= 9) {
    international = countryCode + digits; // "612345678" - leading zero left off
  } else {
    international = digits; // long, unprefixed: assume already international
  }

  // E.164 is at most 15 digits; anything outside a sane range is left alone
  // rather than mangled.
  if (international.length < 8 || international.length > 15) return trimmed;
  return `+${international}`;
}

/**
 * Every stored form the same number is likely to exist in, for looking up
 * customers created before normalisation existed. Includes the raw input.
 */
function phoneLookupVariants(raw) {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const variants = new Set([trimmed]);
  const normalized = normalizePhone(trimmed);
  variants.add(normalized);

  if (/^\+\d+$/.test(normalized)) {
    const digits = normalized.slice(1);
    const cc = defaultCountryCode();
    variants.add(digits); //            31612345678
    variants.add(`00${digits}`); //     0031612345678
    if (digits.startsWith(cc)) variants.add(`0${digits.slice(cc.length)}`); // 0612345678
  }
  return [...variants];
}

/** Oldest-first so a legacy duplicate resolves to the original customer. */
async function findCustomerByPhone(client, businessId, phone) {
  const variants = phoneLookupVariants(phone);
  if (!variants.length) return null;
  return client.customer.findFirst({
    where: { businessId, phone: { in: variants } },
    orderBy: { createdAt: 'asc' },
  });
}

module.exports = { normalizePhone, phoneLookupVariants, findCustomerByPhone };
