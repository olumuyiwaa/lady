/**
 * Reporting for business accounts (customers with a company name), used by the
 * customer portal: monthly summary with per-location and per-service spend,
 * a CSV export, and a printable monthly statement of the issued invoices.
 *
 * Spend is the booked price (VAT included, travel fee included) of visits that
 * were not cancelled. Money outstanding comes from issued invoices.
 */
const prisma = require('../../config/database');
const b2b = require('../../lib/b2bAccount');
const { buildQualityReport } = require('../../lib/qualityReport');
const { languageFor } = require('../../lib/i18n');
const { renderQualityPdf } = require('./quality.pdf');
const companyScope = require('../../lib/companyScope');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function loadAccount(businessId, customerId) {
  const [customer, business] = await Promise.all([
    prisma.customer.findFirst({ where: { id: customerId, businessId } }),
    prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true, currency: true, name: true } }),
  ]);
  if (!customer || !b2b.isBusinessAccount(customer)) throw httpError(403, 'This is only available for business accounts');
  return { customer, timeZone: business?.timezone || 'Europe/Amsterdam', currency: business?.currency || 'eur', businessName: business?.name || '' };
}

const hoursOf = (b) => Math.max(0, (new Date(b.scheduledEnd) - new Date(b.scheduledStart)) / 3600000);
const round1 = (n) => Math.round(n * 10) / 10;
const label = (b) => [b.addressLine1, [b.postalCode, b.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

/** Pure: aggregates bookings into the summary numbers. */
function aggregate(bookings) {
  const locations = new Map();
  const services = new Map();
  let spendCents = 0;
  let travelCents = 0;
  let hours = 0;
  let completed = 0;
  for (const b of bookings) {
    const cents = b.quotedPriceCents || 0;
    spendCents += cents;
    travelCents += b.travelFeeCents || 0;
    hours += hoursOf(b);
    if (b.status === 'COMPLETED') completed += 1;

    const key = b2b.locationKey(b);
    const loc = locations.get(key) || { key, label: label(b), visits: 0, hours: 0, spendCents: 0 };
    loc.visits += 1;
    loc.hours += hoursOf(b);
    loc.spendCents += cents;
    locations.set(key, loc);

    const name = b.service?.name || '—';
    const svc = services.get(name) || { name, visits: 0, spendCents: 0 };
    svc.visits += 1;
    svc.spendCents += cents;
    services.set(name, svc);
  }
  return {
    visits: bookings.length,
    completedVisits: completed,
    spendCents,
    travelCents,
    hours: round1(hours),
    locations: [...locations.values()].map((l) => ({ ...l, hours: round1(l.hours) })).sort((a, b) => b.spendCents - a.spendCents),
    services: [...services.values()].sort((a, b) => b.spendCents - a.spendCents),
  };
}

/** Pure: outstanding / overdue figures from invoices. */
function invoiceFigures(invoices, now = Date.now()) {
  const open = invoices.filter((i) => !i.paidAt);
  const overdue = open.filter((i) => i.dueAt && new Date(i.dueAt).getTime() < now);
  const sum = (xs) => xs.reduce((a, i) => a + (i.grossCents || 0), 0);
  return { openCount: open.length, openCents: sum(open), overdueCount: overdue.length, overdueCents: sum(overdue) };
}

async function getSummary(businessId, customerId, month, scope = null) {
  const { customer, timeZone, currency } = await loadAccount(businessId, customerId);
  const range = b2b.monthRange(month, timeZone);
  const prevRange = b2b.monthRange(range.previous, timeZone);
  const where = (r) => ({ businessId, customerId, status: { not: 'CANCELLED' }, scheduledStart: { gte: r.from, lt: r.to } });

  const [bookings, prevBookings, openInvoices, issued] = await Promise.all([
    prisma.booking.findMany({ where: where(range), include: { service: { select: { name: true } } }, orderBy: { scheduledStart: 'asc' }, take: 2000 }),
    prisma.booking.findMany({ where: where(prevRange), select: { quotedPriceCents: true, addressLine1: true, postalCode: true, city: true }, take: 2000 }),
    prisma.invoice.findMany({ where: { businessId, customerId, paidAt: null }, select: { grossCents: true, dueAt: true, paidAt: true }, take: 1000 }),
    prisma.invoice.findMany({ where: { businessId, customerId, issuedAt: { gte: range.from, lt: range.to } }, select: { grossCents: true }, take: 1000 }),
  ]);

  const restricted = companyScope.isRestricted(scope);
  const mine = restricted ? companyScope.filterInScope(scope, bookings) : bookings;
  const prevMine = restricted ? companyScope.filterInScope(scope, prevBookings) : prevBookings;
  const agg = aggregate(mine);
  return {
    month: range.month,
    currency,
    company: { name: customer.companyName, kvkNumber: customer.kvkNumber, vatNumber: customer.vatNumber, paymentTermsDays: customer.paymentTermsDays },
    ...agg,
    previousSpendCents: prevMine.reduce((a, b) => a + (b.quotedPriceCents || 0), 0),
    // Invoices are company-wide, so a branch manager does not get them.
    invoices: restricted ? { issuedCount: 0, issuedCents: 0, openCount: 0, openCents: 0, overdueCount: 0, overdueCents: 0 } : { issuedCount: issued.length, issuedCents: issued.reduce((a, i) => a + i.grossCents, 0), ...invoiceFigures(openInvoices) },
  };
}

/** CSV of visits between two dates (inclusive of `from`, exclusive of `to`). */
async function exportVisitsCsv(businessId, customerId, { from, to, month }, scope = null) {
  const { timeZone } = await loadAccount(businessId, customerId);
  let start = from ? new Date(from) : null;
  let end = to ? new Date(to) : null;
  if (month && !from && !to) {
    // A whole calendar month in the business timezone.
    const r = b2b.monthRange(month, timeZone);
    start = r.from;
    end = r.to;
  }
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw httpError(422, 'Choose a valid date range');
  if (end - start > 400 * 24 * 3600 * 1000) throw httpError(422, 'Date range is too long (max 400 days)');

  const all = await prisma.booking.findMany({
    where: { businessId, customerId, scheduledStart: { gte: start, lt: end } },
    include: { service: { select: { name: true } }, invoice: { select: { number: true, paidAt: true, dueAt: true } } },
    orderBy: { scheduledStart: 'asc' },
    take: 5000,
  });
  const bookings = companyScope.filterInScope(scope, all);
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' });
  const eur = (c) => ((c || 0) / 100).toFixed(2);
  const rows = [['Date', 'Location', 'Service', 'Status', 'Hours', 'Travel fee', 'Total incl. VAT', 'Invoice', 'Paid']];
  for (const b of bookings) {
    rows.push([
      fmt.format(new Date(b.scheduledStart)),
      label(b),
      b.service?.name || '',
      b.status,
      round1(hoursOf(b)),
      eur(b.travelFeeCents),
      eur(b.quotedPriceCents),
      b.invoice?.number || '',
      b.invoice ? (b.invoice.paidAt ? 'yes' : 'no') : '',
    ]);
  }
  return b2b.toCsv(rows);
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: String(cur || 'eur').toUpperCase() }).format((cents || 0) / 100);

/** Printable statement: the invoices issued in a month and what is still unpaid. */
async function renderStatementHtml(businessId, customerId, month) {
  const { customer, timeZone, currency, businessName } = await loadAccount(businessId, customerId);
  const range = b2b.monthRange(month, timeZone);
  const invoices = await prisma.invoice.findMany({
    where: { businessId, customerId, issuedAt: { gte: range.from, lt: range.to } },
    orderBy: { sequence: 'asc' },
    take: 1000,
  });
  const date = (d) => new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeZone }).format(new Date(d));
  const total = invoices.reduce((a, i) => a + i.grossCents, 0);
  const unpaid = invoices.filter((i) => !i.paidAt).reduce((a, i) => a + i.grossCents, 0);
  const rows = invoices
    .map(
      (i) =>
        `<tr><td>${esc(i.number)}</td><td>${esc(date(i.issuedAt))}</td><td>${i.dueAt ? esc(date(i.dueAt)) : '—'}</td><td class="r">${money(i.grossCents, currency)}</td><td>${i.paidAt ? 'Betaald' : 'Open'}</td></tr>`
    )
    .join('');
  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Overzicht ${esc(range.month)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}.muted{color:#555}.r{text-align:right}table{width:100%;border-collapse:collapse;margin:24px 0}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}th.r{text-align:right}@media print{body{margin:0}}</style></head><body>
<h1>Maandoverzicht ${esc(range.month)}</h1>
<div class="muted">${esc(businessName)} voor ${esc(customer.companyName)}${customer.vatNumber ? ` · BTW-id ${esc(customer.vatNumber)}` : ''}</div>
<table><thead><tr><th>Factuur</th><th>Datum</th><th>Vervaldatum</th><th class="r">Bedrag incl. BTW</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="5">Geen facturen in deze maand</td></tr>'}</tbody></table>
<p><strong>Totaal gefactureerd:</strong> ${money(total, currency)}<br><strong>Nog te betalen:</strong> ${money(unpaid, currency)}</p>
<p class="muted">Dit overzicht is geen factuur. De facturen zelf zijn te openen via het klantenportaal.</p>
</body></html>`;
}

/** Quality figures per branch for a month: JSON for the portal and the data behind the PDF. */
async function getQualityReport(businessId, customerId, month, scope = null) {
  const { customer, timeZone, businessName } = await loadAccount(businessId, customerId);
  const range = b2b.monthRange(month, timeZone);
  const allBookings = await prisma.booking.findMany({
    where: { businessId, customerId, status: { not: 'CANCELLED' }, scheduledStart: { gte: range.from, lt: range.to } },
    include: { review: { select: { rating: true } }, checklist: { select: { items: true } }, assignments: { select: { checkedInAt: true } } },
    orderBy: { scheduledStart: 'asc' },
    take: 2000,
  });
  const bookings = companyScope.filterInScope(scope, allBookings);
  const tickets = bookings.length
    ? await prisma.supportTicket.findMany({ where: { businessId, kind: 'COMPLAINT', bookingId: { in: bookings.map((b) => b.id) } }, select: { bookingId: true }, take: 5000 })
    : [];
  const byBooking = new Map();
  for (const t of tickets) byBooking.set(t.bookingId, (byBooking.get(t.bookingId) || 0) + 1);
  const report = buildQualityReport(bookings, byBooking, label);
  return { month: range.month, company: { name: customer.companyName }, businessName, language: languageFor(customer), ...report };
}

async function renderQualityPdfFor(businessId, customerId, month, scope = null) {
  const data = await getQualityReport(businessId, customerId, month, scope);
  return renderQualityPdf({ report: data, month: data.month, companyName: data.company.name, businessName: data.businessName, language: data.language });
}

module.exports = { getQualityReport, renderQualityPdfFor, getSummary, exportVisitsCsv, renderStatementHtml, aggregate, invoiceFigures, loadAccount };
