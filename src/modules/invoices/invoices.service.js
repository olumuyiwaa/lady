const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const { getZonedParts } = require('../../utils/timezone');
const { vatRateFor, splitGross } = require('../../lib/vat');
const { generateUBLInvoiceXML } = require('../../lib/ubl');

/**
 * Customer invoices (factuur) with BTW.
 *
 * v1 scope: one invoice per booking, VAT extracted from the VAT-inclusive
 * price, consecutive numbering per business, immutable snapshots of supplier
 * and customer. Not included yet: credit notes (needed to correct an issued
 * invoice), e-invoicing (UBL/Peppol), reverse-charge (BTW verlegd) B2B and
 * separate invoices for cancellation fees.
 */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const pad = (n, w) => String(n).padStart(w, '0');

/** `2026-00042`: issue year (business timezone) + a per-business sequence that never restarts, so it stays gapless. */
function formatNumber(issuedAt, sequence, timeZone) {
  const year = getZonedParts(issuedAt, timeZone || 'Europe/Amsterdam').year;
  return `${year}-${pad(sequence, 5)}`;
}

function buildLines(booking, rateBps) {
  const addOns = Array.isArray(booking.addOns) ? booking.addOns : [];
  const description = addOns.length
    ? `${booking.service.name} (incl. ${addOns.map((a) => a.name).join(', ')})`
    : booking.service.name;
  // One line for the whole amount the customer was quoted. Discounts, add-ons
  // and frequency pricing are already folded into quotedPriceCents; splitting
  // it into lines here would mean inventing numbers.
  return [{ description, quantity: 1, ...splitGross(booking.quotedPriceCents, rateBps) }];
}

async function issueForBooking(businessId, bookingId, actorUserId) {
  const existing = await prisma.invoice.findFirst({ where: { businessId, bookingId } });
  if (existing) return existing; // idempotent

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId },
    include: { customer: true, service: true, business: true },
  });
  if (!booking) throw httpError(404, 'Booking not found');
  if (booking.status === 'CANCELLED') throw httpError(422, 'A cancelled booking cannot be invoiced');
  if (!(booking.quotedPriceCents > 0)) throw httpError(422, 'Nothing to invoice: this booking has no price');

  const b = booking.business;
  if (!b.kvkNumber || !b.vatNumber) {
    throw httpError(422, 'Add your KvK number and BTW-id in your business settings before issuing invoices.');
  }

  const address = await prisma.businessAddress.findFirst({ where: { businessId }, orderBy: { createdAt: 'asc' } });
  const rateBps = vatRateFor(booking.service, b);
  const totals = splitGross(booking.quotedPriceCents, rateBps);
  const lines = buildLines(booking, rateBps);
  const timeZone = b.timezone || 'Europe/Amsterdam';

  const supplier = {
    name: b.legalName || b.name,
    tradeName: b.legalName && b.legalName !== b.name ? b.name : null,
    kvkNumber: b.kvkNumber,
    vatNumber: b.vatNumber,
    iban: b.invoiceIban || null,
    address: address
      ? { line1: address.line1, line2: address.line2 || null, postalCode: address.postalCode, city: address.city, country: address.country }
      : null,
  };
  const customer = {
    name: [booking.customer.firstName, booking.customer.lastName].filter(Boolean).join(' '),
    email: booking.customer.email || null,
    address: {
      line1: booking.addressLine1,
      line2: booking.addressLine2 || null,
      postalCode: booking.postalCode || null,
      city: booking.city,
    },
  };

  const issuedAt = new Date();
  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      // Atomic increment: concurrent issuers get distinct, consecutive numbers.
      const counter = await tx.invoiceCounter.upsert({
        where: { businessId },
        create: { businessId, lastSequence: 1 },
        update: { lastSequence: { increment: 1 } },
      });
      return tx.invoice.create({
        data: {
          businessId,
          bookingId,
          customerId: booking.customerId,
          sequence: counter.lastSequence,
          number: formatNumber(issuedAt, counter.lastSequence, timeZone),
          currency: b.currency || 'eur',
          vatRateBps: totals.vatRateBps,
          netCents: totals.netCents,
          vatCents: totals.vatCents,
          grossCents: totals.grossCents,
          supplier,
          customerSnapshot: customer,
          lines,
          issuedAt,
          // Paid up front (card/iDEAL/gift card) -> mark paid.
          paidAt: booking.paymentStatus === 'PAID' ? issuedAt : null,
        },
      });
    });
  } catch (err) {
    // Two requests issued the same booking at once: the loser rolled back (its
    // sequence number is released with it - no gap) and returns the winner's invoice.
    if (err.code === 'P2002') {
      const winner = await prisma.invoice.findFirst({ where: { businessId, bookingId } });
      if (winner) return winner;
    }
    throw err;
  }

  await audit({
    businessId,
    actorUserId,
    action: 'INVOICE_ISSUED',
    entityType: 'Invoice',
    entityId: created.id,
    metadata: { bookingId, number: created.number, grossCents: created.grossCents },
  });
  return created;
}

async function listInvoices(businessId, { from, to, limit = 50, skip = 0 } = {}) {
  const where = { businessId };
  if (from || to) {
    where.issuedAt = {};
    if (from) where.issuedAt.gte = new Date(from);
    if (to) where.issuedAt.lte = new Date(to);
  }
  return prisma.invoice.findMany({
    where,
    orderBy: { sequence: 'desc' },
    take: Math.min(Math.max(Number(limit) || 50, 1), 200),
    skip: Math.max(Number(skip) || 0, 0),
  });
}

async function getInvoice(businessId, id) {
  const inv = await prisma.invoice.findFirst({ where: { id, businessId } });
  if (!inv) throw httpError(404, 'Invoice not found');
  return inv;
}

async function getInvoiceForBooking(businessId, bookingId, customerId) {
  const inv = await prisma.invoice.findFirst({ where: { businessId, bookingId, ...(customerId ? { customerId } : {}) } });
  if (!inv) throw httpError(404, 'No invoice has been issued for this booking yet');
  return inv;
}

// ---- printable HTML --------------------------------------------------------

const esc = (v) =>
  String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(cents, currency) {
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: String(currency || 'eur').toUpperCase() }).format((cents || 0) / 100);
}

const addressLines = (a) => (a ? [a.line1, a.line2, [a.postalCode, a.city].filter(Boolean).join(' '), a.country].filter(Boolean) : []);

/**
 * Self-contained printable invoice (browser "print to PDF"). Every value is
 * HTML-escaped: names, notes and service titles are user-controlled.
 */
function renderInvoiceHtml(inv, timeZone = 'Europe/Amsterdam') {
  const s = inv.supplier || {};
  const c = inv.customerSnapshot || {};
  const date = (d) => new Intl.DateTimeFormat('nl-NL', { dateStyle: 'long', timeZone }).format(new Date(d));
  const rate = `${(inv.vatRateBps / 100).toString().replace('.', ',')}%`;
  const rows = (inv.lines || [])
    .map(
      (l) => `<tr><td>${esc(l.description)}</td><td class="r">${esc(l.quantity)}</td><td class="r">${money(l.netCents, inv.currency)}</td><td class="r">${(l.vatRateBps / 100).toString().replace('.', ',')}%</td><td class="r">${money(l.grossCents, inv.currency)}</td></tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8">
<!-- The dashboard opens this as a blob: page on the app origin, where no CSP response header applies. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Factuur ${esc(inv.number)}</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 16px}
  h1{font-size:22px;margin:0 0 4px} .muted{color:#555} .r{text-align:right}
  table{width:100%;border-collapse:collapse;margin:24px 0} th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}
  .cols{display:flex;justify-content:space-between;gap:24px} .tot td{border:0} .tot .b{font-weight:700}
  @media print{body{margin:0}}
</style></head><body>
<div class="cols"><div><h1>Factuur</h1><div class="muted">Factuurnummer: <strong>${esc(inv.number)}</strong><br>Factuurdatum: ${esc(date(inv.issuedAt))}${inv.paidAt ? `<br>Betaald op: ${esc(date(inv.paidAt))}` : ''}</div></div>
<div class="r"><strong>${esc(s.name)}</strong>${s.tradeName ? `<br>${esc(s.tradeName)}` : ''}${addressLines(s.address).map((l) => `<br>${esc(l)}`).join('')}<br>KvK: ${esc(s.kvkNumber)}<br>BTW-id: ${esc(s.vatNumber)}${s.iban ? `<br>IBAN: ${esc(s.iban)}` : ''}</div></div>
<p><strong>Factuur aan</strong><br>${esc(c.name)}${addressLines(c.address).map((l) => `<br>${esc(l)}`).join('')}${c.email ? `<br>${esc(c.email)}` : ''}</p>
<table><thead><tr><th>Omschrijving</th><th class="r">Aantal</th><th class="r">Excl. BTW</th><th class="r">BTW</th><th class="r">Incl. BTW</th></tr></thead><tbody>${rows}</tbody></table>
<table class="tot" style="width:auto;margin-left:auto"><tr><td>Totaal excl. BTW</td><td class="r">${money(inv.netCents, inv.currency)}</td></tr><tr><td>BTW ${esc(rate)}</td><td class="r">${money(inv.vatCents, inv.currency)}</td></tr><tr class="b"><td class="b">Totaal incl. BTW</td><td class="r b">${money(inv.grossCents, inv.currency)}</td></tr></table>
</body></html>`;
}

module.exports = { issueForBooking, listInvoices, getInvoice, getInvoiceForBooking, renderInvoiceHtml, generateUBLInvoiceXML, formatNumber, buildLines, esc };
