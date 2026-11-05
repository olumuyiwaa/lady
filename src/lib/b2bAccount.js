/**
 * Business-customer ("B2B") account details on a Customer, and the small pure
 * helpers the B2B portal and reports share.
 *
 * A customer is a business account when it has a company name. Everything else
 * is optional: KvK and BTW numbers are shown on invoices, a billing email gets
 * the invoices, and payment terms (days) set the invoice due date, because
 * companies pay on account rather than at booking time.
 */
const { normalizeKvk, normalizeVatNumber } = require('./taxIdentifiers');

const FIELDS = ['companyName', 'kvkNumber', 'vatNumber', 'billingEmail', 'paymentTermsDays'];

function bad(message) {
  const err = new Error(message);
  err.status = 422;
  return err;
}

/**
 * Validates and normalises the B2B fields present in `input`. Returns only the
 * keys that were provided (so a PUT can leave the rest alone); empty strings
 * clear a field. Throws a 422 on invalid values.
 */
function cleanB2bFields(input = {}) {
  const out = {};
  const has = (k) => input[k] !== undefined;
  const str = (v) => (v == null ? '' : String(v).trim());

  if (has('companyName')) {
    const v = str(input.companyName).replace(/\s+/g, ' ');
    if (v.length > 120) throw bad('Company name is too long');
    out.companyName = v || null;
  }
  if (has('kvkNumber')) {
    const raw = str(input.kvkNumber);
    const v = raw ? normalizeKvk(raw) : null;
    if (raw && !v) throw bad('KvK number must be 8 digits');
    out.kvkNumber = v;
  }
  if (has('vatNumber')) {
    const raw = str(input.vatNumber);
    const v = raw ? normalizeVatNumber(raw) : null;
    if (raw && !v) throw bad('VAT number looks invalid (for example NL123456789B01)');
    out.vatNumber = v;
  }
  if (has('billingEmail')) {
    const v = str(input.billingEmail).toLowerCase();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw bad('Billing email is not a valid email address');
    out.billingEmail = v || null;
  }
  if (has('paymentTermsDays')) {
    const raw = input.paymentTermsDays;
    if (raw === null || raw === '') out.paymentTermsDays = null;
    else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 120) throw bad('Payment terms must be a whole number of days between 0 and 120');
      out.paymentTermsDays = n;
    }
  }
  return out;
}

const isBusinessAccount = (customer) => !!(customer && customer.companyName);

/** Invoice due date: issue date plus payment terms; null when the customer pays up front. */
function dueDateFor(customer, issuedAt) {
  if (!isBusinessAccount(customer) || !(customer.paymentTermsDays > 0)) return null;
  return new Date(new Date(issuedAt).getTime() + customer.paymentTermsDays * 24 * 60 * 60 * 1000);
}

/** The name an invoice is addressed to. */
function invoiceName(customer) {
  const person = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
  return isBusinessAccount(customer) ? customer.companyName : person;
}

/** Stable grouping key for a service address (same place, however it was typed). */
function locationKey(b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return [norm(b.postalCode).replace(/ /g, ''), norm(b.addressLine1), norm(b.city)].join('|');
}

/** Start of `YYYY-MM` in `timeZone`, as a UTC Date. */
function monthStart(year, month, timeZone = 'Europe/Amsterdam') {
  const guess = Date.UTC(year, month - 1, 1);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(guess));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return new Date(guess - (asUtc - guess));
}

/** { from, to, month } for 'YYYY-MM' (defaults to the current month in the business timezone). */
function monthRange(month, timeZone = 'Europe/Amsterdam', now = new Date()) {
  let y;
  let m;
  const match = typeof month === 'string' && /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (match) {
    y = Number(match[1]);
    m = Number(match[2]);
  } else {
    const p = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(now);
    y = Number(p.find((x) => x.type === 'year').value);
    m = Number(p.find((x) => x.type === 'month').value);
  }
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return {
    month: `${y}-${String(m).padStart(2, '0')}`,
    from: monthStart(y, m, timeZone),
    to: monthStart(ny, nm, timeZone),
    previous: m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`,
  };
}

/** One CSV cell: quoted when needed, and neutralised against spreadsheet formula injection. */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  // BOM so Excel opens UTF-8 (names, umlauts) correctly.
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { FIELDS, cleanB2bFields, isBusinessAccount, dueDateFor, invoiceName, locationKey, monthRange, monthStart, csvCell, toCsv };
