/**
 * BTW / VAT helpers. Every price in Tod Cleaning Services is VAT-INCLUSIVE (gross): that is
 * how consumer prices must be displayed in the Netherlands. VAT is therefore
 * extracted from the gross amount, never added on top, so what the customer
 * was quoted is exactly what they are charged and invoiced.
 *
 * Rates are basis points: 2100 = 21% (Dutch standard rate), 900 = 9%.
 */
const DEFAULT_VAT_RATE_BPS = 2100;

function defaultRateBps() {
  const n = Number(process.env.DEFAULT_VAT_RATE_BPS);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_VAT_RATE_BPS;
}

/** The rate for a service: its own override, else the business default, else the platform default. */
function vatRateFor(service, business) {
  const own = service && Number.isInteger(service.vatRateBps) ? service.vatRateBps : null;
  if (own !== null) return own;
  if (business && Number.isInteger(business.vatRateBps)) return business.vatRateBps;
  return defaultRateBps();
}

/** Splits a gross amount into net + VAT. net + vat === gross always (rounding goes to VAT). */
function splitGross(grossCents, rateBps) {
  const gross = Math.round(grossCents || 0);
  const net = Math.round((gross * 10000) / (10000 + rateBps));
  return { netCents: net, vatCents: gross - net, grossCents: gross, vatRateBps: rateBps };
}

module.exports = { DEFAULT_VAT_RATE_BPS, vatRateFor, splitGross };
