/**
 * Customer-facing language. Two languages are supported, matching the site:
 * Dutch ('nl') and English ('en'). A customer's stored language wins; without
 * one the business default applies (DEFAULT_CUSTOMER_LANGUAGE, else Dutch).
 */
const SUPPORTED = ['nl', 'en'];

function normalizeLanguage(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase().slice(0, 2);
  return SUPPORTED.includes(v) ? v : null;
}

function defaultLanguage() {
  return normalizeLanguage(process.env.DEFAULT_CUSTOMER_LANGUAGE) || 'nl';
}

/** The language to use for a customer (or any object with a `language`). */
function languageFor(customer) {
  return normalizeLanguage(customer && customer.language) || defaultLanguage();
}

module.exports = { SUPPORTED, normalizeLanguage, defaultLanguage, languageFor };
