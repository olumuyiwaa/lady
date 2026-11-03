/**
 * UBL 2.1 Invoice export — for a business's own bookkeeping, not Peppol
 * network transmission. Scope, deliberately: a well-formed UBL 2.1
 * <Invoice> document carrying every field Dutch accounting tools (Exact
 * Online, Moneybird, e-Boekhouden, SnelStart) read on manual/file-based
 * UBL import — supplier + customer identity, KvK/BTW, line items, VAT
 * breakdown, totals. NOT a Peppol BIS Billing 3.0 conformant document:
 * that needs an Access Point integration, Peppol participant IDs
 * (cbc:EndpointID with a scheme like 0106/9944), and registration in the
 * Peppol directory — real network-transmission infrastructure, not a file
 * format. If actual Peppol e-invoicing (sending an invoice that arrives in
 * the customer's own accounting system automatically) becomes a
 * requirement, this file is the right place to add those elements, but
 * it's a materially bigger undertaking than generating the XML itself.
 */

const esc = (v) =>
  String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** UBL amounts are plain decimals ("123.45"), never cents. */
const decimal = (cents) => ((cents || 0) / 100).toFixed(2);

const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

function partyAddressXml(addr, fallbackCountry) {
  if (!addr) return '';
  return `<cac:PostalAddress>
      ${addr.line1 ? `<cbc:StreetName>${esc(addr.line1)}</cbc:StreetName>` : ''}
      ${addr.line2 ? `<cbc:AdditionalStreetName>${esc(addr.line2)}</cbc:AdditionalStreetName>` : ''}
      ${addr.city ? `<cbc:CityName>${esc(addr.city)}</cbc:CityName>` : ''}
      ${addr.postalCode ? `<cbc:PostalZone>${esc(addr.postalCode)}</cbc:PostalZone>` : ''}
      <cac:Country><cbc:IdentificationCode>${esc(addr.country || fallbackCountry || 'NL')}</cbc:IdentificationCode></cac:Country>
    </cac:PostalAddress>`;
}

/**
 * Groups invoice lines by VAT rate into one or more TaxSubtotal blocks —
 * v1 only ever creates a single line so this always collapses to one
 * subtotal in practice, but a UBL document with multiple differently-taxed
 * lines is only valid if the TaxTotal breaks them out per rate, so this
 * doesn't assume single-rate the way the HTML invoice's flat display does.
 */
function taxSubtotalsXml(lines, currency) {
  const byRate = new Map();
  for (const l of lines) {
    const key = l.vatRateBps;
    const acc = byRate.get(key) || { netCents: 0, vatCents: 0 };
    acc.netCents += l.netCents;
    acc.vatCents += l.vatCents;
    byRate.set(key, acc);
  }
  return [...byRate.entries()]
    .map(
      ([rateBps, t]) => `<cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${currency}">${decimal(t.netCents)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${currency}">${decimal(t.vatCents)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>${(rateBps / 100).toFixed(2)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>`
    )
    .join('\n      ');
}

function invoiceLineXml(l, i, currency) {
  return `<cac:InvoiceLine>
      <cbc:ID>${i + 1}</cbc:ID>
      <cbc:InvoicedQuantity>${esc(l.quantity)}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${currency}">${decimal(l.netCents)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Name>${esc(l.description)}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:Percent>${(l.vatRateBps / 100).toFixed(2)}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${currency}">${decimal(l.netCents / (l.quantity || 1))}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`;
}

/**
 * @param {object} inv - an Invoice row (as returned by getInvoice/issueForBooking):
 *   number, issuedAt, currency, vatRateBps, netCents, vatCents, grossCents,
 *   supplier, customerSnapshot, lines.
 * @returns {string} a complete UBL 2.1 Invoice XML document.
 */
function generateUBLInvoiceXML(inv) {
  const s = inv.supplier || {};
  const c = inv.customerSnapshot || {};
  const currency = String(inv.currency || 'eur').toUpperCase();
  const lines = inv.lines || [];

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ID>${esc(inv.number)}</cbc:ID>
  <cbc:IssueDate>${isoDate(inv.issuedAt)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${currency}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      ${partyAddressXml(s.address, 'NL')}
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(s.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(s.name)}</cbc:RegistrationName>
        <cbc:CompanyID>${esc(s.kvkNumber)}</cbc:CompanyID>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      ${partyAddressXml(c.address, 'NL')}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${esc(c.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
      ${c.email ? `<cac:Contact><cbc:ElectronicMail>${esc(c.email)}</cbc:ElectronicMail></cac:Contact>` : ''}
    </cac:Party>
  </cac:AccountingCustomerParty>
  ${s.iban ? `<cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount><cbc:ID>${esc(s.iban)}</cbc:ID></cac:PayeeFinancialAccount>
  </cac:PaymentMeans>` : ''}
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${currency}">${decimal(inv.vatCents)}</cbc:TaxAmount>
    ${taxSubtotalsXml(lines, currency)}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${currency}">${decimal(inv.netCents)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${currency}">${decimal(inv.netCents)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${currency}">${decimal(inv.grossCents)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${currency}">${decimal(inv.grossCents)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${lines.map((l, i) => invoiceLineXml(l, i, currency)).join('\n  ')}
</Invoice>`;
}

module.exports = { generateUBLInvoiceXML };
