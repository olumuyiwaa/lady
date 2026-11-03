/**
 * Human-readable dates and money for messages people actually read. Interpolating a Date
 * into a template string produced text like "Mon Sep 21 2026 08:00:00 GMT+0000" in the
 * server's timezone, which is neither the customer's language nor the business's clock.
 */
const DEFAULT_LOCALE = () => process.env.DEFAULT_LOCALE || 'nl-NL';

function formatDateTime(date, { timeZone = 'Europe/Amsterdam', locale } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(locale || DEFAULT_LOCALE(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(d);
}

function formatMoney(cents, currency = 'eur', locale) {
  return new Intl.NumberFormat(locale || DEFAULT_LOCALE(), {
    style: 'currency',
    currency: String(currency).toUpperCase(),
  }).format((cents || 0) / 100);
}

module.exports = { formatDateTime, formatMoney };
