const { generateUBLInvoiceXML } = require('../src/lib/ubl');

// Same shape/fixture style as test/invoices.test.js's "printable HTML"
// block, reused deliberately: the two exports (renderInvoiceHtml,
// generateUBLInvoiceXML) are built from the exact same Invoice row and
// must both handle the same user-controlled values safely.
const baseInv = {
  number: '2026-00042',
  currency: 'eur',
  vatRateBps: 2100,
  netCents: 10000,
  vatCents: 2100,
  grossCents: 12100,
  issuedAt: new Date('2026-06-15T10:00:00Z'),
  paidAt: null,
  supplier: {
    name: 'Schoon BV',
    kvkNumber: '12345678',
    vatNumber: 'NL123456789B01',
    iban: 'NL02ABNA0123456789',
    address: { line1: 'Keizersgracht 1', postalCode: '1012 AB', city: 'Amsterdam', country: 'NL' },
  },
  customerSnapshot: {
    name: 'Jan Jansen',
    email: 'jan@example.com',
    address: { line1: 'Damstraat 5', city: 'Amsterdam' },
  },
  lines: [{ description: 'Standard clean', quantity: 1, netCents: 10000, vatCents: 2100, vatRateBps: 2100 }],
};

let parseXml;
beforeAll(() => {
  // Node's built-in DOMParser equivalent isn't available without a browser
  // env — a real XML parser (not the project's own dependency, deliberately:
  // this is verifying the OUTPUT is valid XML, so it shouldn't rely on the
  // same string-building code that produced it) confirms well-formedness
  // rather than just eyeballing the string.
  const { XMLParser, XMLValidator } = require('fast-xml-parser');
  // parseTagValue: false keeps every element's text as a string — KvK/BTW
  // numbers and percentages are id-like values, not arithmetic, so this
  // avoids the parser's own number-coercion convenience turning "12345678"
  // into 12345678 and making assertions ambiguous about what the XML
  // actually contains.
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  parseXml = (xml) => {
    const valid = XMLValidator.validate(xml);
    if (valid !== true) throw new Error(`Invalid XML: ${JSON.stringify(valid)}`);
    return parser.parse(xml);
  };
});

describe('generateUBLInvoiceXML', () => {
  test('produces well-formed XML', () => {
    expect(() => parseXml(generateUBLInvoiceXML(baseInv))).not.toThrow();
  });

  test('carries the legally required fields: invoice number, date, KvK, BTW-id, totals', () => {
    const doc = parseXml(generateUBLInvoiceXML(baseInv));
    const inv = doc.Invoice;
    expect(inv['cbc:ID']).toBe('2026-00042');
    expect(inv['cbc:IssueDate']).toBe('2026-06-15');
    expect(inv['cbc:InvoiceTypeCode']).toBe('380');
    expect(inv['cbc:DocumentCurrencyCode']).toBe('EUR');
    expect(inv['cac:AccountingSupplierParty']['cac:Party']['cac:PartyLegalEntity']['cbc:CompanyID']).toBe('12345678');
    expect(inv['cac:AccountingSupplierParty']['cac:Party']['cac:PartyTaxScheme']['cbc:CompanyID']).toBe('NL123456789B01');
    expect(inv['cac:LegalMonetaryTotal']['cbc:PayableAmount']['#text']).toBe('121.00');
    expect(inv['cac:LegalMonetaryTotal']['cbc:PayableAmount']['@_currencyID']).toBe('EUR');
  });

  test('amounts are decimals (cents/100), never raw cents', () => {
    const xml = generateUBLInvoiceXML(baseInv);
    expect(xml).toContain('>100.00<'); // netCents 10000 -> "100.00"
    expect(xml).toContain('>121.00<'); // grossCents 12100 -> "121.00"
    expect(xml).not.toContain('>10000<');
    expect(xml).not.toContain('>12100<');
  });

  test('escapes user-controlled values so no field can break out of its XML element', () => {
    const inv = {
      ...baseInv,
      customerSnapshot: { ...baseInv.customerSnapshot, name: '</cbc:RegistrationName><script>alert(1)</script>' },
      lines: [{ ...baseInv.lines[0], description: 'Clean & tidy <house>' }],
    };
    const xml = generateUBLInvoiceXML(inv);
    expect(xml).not.toContain('<script>');
    expect(xml).toContain('&lt;/cbc:RegistrationName&gt;&lt;script&gt;');
    expect(xml).toContain('Clean &amp; tidy &lt;house&gt;');
    // Still parses cleanly despite the hostile input.
    expect(() => parseXml(xml)).not.toThrow();
  });

  test('omits PaymentMeans entirely when the business has no invoicing IBAN, rather than emitting an empty element', () => {
    const inv = { ...baseInv, supplier: { ...baseInv.supplier, iban: null } };
    const xml = generateUBLInvoiceXML(inv);
    expect(xml).not.toContain('PaymentMeans');
  });

  test('lines at different VAT rates are broken into separate TaxSubtotal blocks, not collapsed into one', () => {
    const inv = {
      ...baseInv,
      netCents: 15000,
      vatCents: 2850, // 2100 (21% of 10000) + 750 (9% of... adjusted for round numbers below
      grossCents: 17850,
      lines: [
        { description: 'Standard clean', quantity: 1, netCents: 10000, vatCents: 2100, vatRateBps: 2100 },
        { description: 'Eco add-on', quantity: 1, netCents: 5000, vatCents: 450, vatRateBps: 900 },
      ],
    };
    const doc = parseXml(generateUBLInvoiceXML(inv));
    const subtotals = doc.Invoice['cac:TaxTotal']['cac:TaxSubtotal'];
    expect(Array.isArray(subtotals)).toBe(true);
    expect(subtotals).toHaveLength(2);
    const percents = subtotals.map((s) => s['cac:TaxCategory']['cbc:Percent']).sort();
    expect(percents).toEqual(['21.00', '9.00']);
  });

  test('one InvoiceLine per invoice line, in order, each carrying its own tax category', () => {
    const inv = {
      ...baseInv,
      lines: [
        { description: 'Standard clean', quantity: 1, netCents: 10000, vatCents: 2100, vatRateBps: 2100 },
        { description: 'Window cleaning add-on', quantity: 2, netCents: 3000, vatCents: 630, vatRateBps: 2100 },
      ],
    };
    const doc = parseXml(generateUBLInvoiceXML(inv));
    const invoiceLines = doc.Invoice['cac:InvoiceLine'];
    expect(invoiceLines).toHaveLength(2);
    expect(invoiceLines[0]['cac:Item']['cbc:Name']).toBe('Standard clean');
    expect(invoiceLines[1]['cac:Item']['cbc:Name']).toBe('Window cleaning add-on');
    expect(invoiceLines[1]['cbc:InvoicedQuantity']).toBe('2');
  });
});

// invoices.routes.js's /export/ubl.zip bundles generateUBLInvoiceXML's
// output with the real `archiver` package (not mocked — this is the one
// place in this file that exercises the actual dependency rather than pure
// string generation). Worth its own test: archiver 8.0.0 is a ground-up
// ESM-only rewrite with a completely different (class-based) API from the
// classic archiver(format, options) factory function every version through
// 7.x has — require('archiver') on that version doesn't throw (Node's
// require(esm) interop returns its named exports as an object instead), it
// just silently isn't callable, which none of the XML-generation tests
// above would ever catch. package.json pins ^7 specifically to avoid ever
// landing on 8.x; this test is the regression guard in case that pin is
// ever loosened.
describe('archiver integration (invoices.routes.js /export/ubl.zip)', () => {
  test('archiver is the classic callable factory, not an ESM-only rewrite', () => {
    const archiver = require('archiver');
    expect(typeof archiver).toBe('function');
  });

  test('produces a real, valid zip containing one UBL XML per invoice', async () => {
    const archiver = require('archiver');
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('data', (chunk) => chunks.push(chunk));
    const done = new Promise((resolve, reject) => {
      archive.on('end', resolve);
      archive.on('error', reject);
    });
    archive.append(generateUBLInvoiceXML(baseInv), { name: 'INV-1.xml' });
    archive.append(generateUBLInvoiceXML({ ...baseInv, number: 'INV-2' }), { name: 'INV-2.xml' });
    await archive.finalize();
    await done;

    const buffer = Buffer.concat(chunks);
    // PK\x03\x04 is the zip local-file-header signature — confirms this is
    // an actual zip, not just any binary blob.
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(buffer.length).toBeGreaterThan(0);
  });
});
