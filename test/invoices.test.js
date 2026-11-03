jest.mock('../src/config/database.js', () => {
  const db = {
    invoice: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn() },
    invoiceCounter: { upsert: jest.fn() },
    booking: { findFirst: jest.fn() },
    businessAddress: { findFirst: jest.fn() },
  };
  db.$transaction = jest.fn((cb) => cb(db));
  return db;
});
jest.mock('../src/utils/audit', () => ({ audit: jest.fn() }));

const prisma = require('../src/config/database.js');
const { audit } = require('../src/utils/audit');
const svc = require('../src/modules/invoices/invoices.service');
const { splitGross, vatRateFor } = require('../src/lib/vat');
const { normalizeKvk, normalizeVatNumber, normalizeIban } = require('../src/lib/taxIdentifiers');

describe('VAT maths (prices are VAT-inclusive)', () => {
  test('extracts 21% BTW from a gross amount; net + vat always equals gross', () => {
    expect(splitGross(12100, 2100)).toEqual({ netCents: 10000, vatCents: 2100, grossCents: 12100, vatRateBps: 2100 });
    for (const gross of [1, 99, 8000, 9999, 12345, 100001]) {
      for (const rate of [0, 900, 2100]) {
        const r = splitGross(gross, rate);
        expect(r.netCents + r.vatCents).toBe(gross);
      }
    }
  });
  test('0% and 9% rates', () => {
    expect(splitGross(10900, 900)).toMatchObject({ netCents: 10000, vatCents: 900 });
    expect(splitGross(5000, 0)).toMatchObject({ netCents: 5000, vatCents: 0 });
  });
  test('service override beats business default beats platform default', () => {
    expect(vatRateFor({ vatRateBps: 900 }, { vatRateBps: 2100 })).toBe(900);
    expect(vatRateFor({ vatRateBps: null }, { vatRateBps: 0 })).toBe(0);
    expect(vatRateFor({}, {})).toBe(2100);
  });
});

describe('tax identifiers', () => {
  test('KvK: 8 digits', () => {
    expect(normalizeKvk('1234 5678')).toBe('12345678');
    expect(normalizeKvk('1234567')).toBeNull();
    expect(normalizeKvk('abcdefgh')).toBeNull();
  });
  test('BTW-id: NL format is strict, other EU countries are lenient', () => {
    expect(normalizeVatNumber('nl 1234.56.789.b01')).toBe('NL123456789B01');
    expect(normalizeVatNumber('NL123456789')).toBeNull();
    expect(normalizeVatNumber('BE0123456789')).toBe('BE0123456789');
    expect(normalizeVatNumber('12345')).toBeNull();
  });
  test('IBAN: mod-97 checksum', () => {
    expect(normalizeIban('NL91 ABNA 0417 1643 00')).toBe('NL91ABNA0417164300');
    expect(normalizeIban('NL91 ABNA 0417 1643 01')).toBeNull();
    expect(normalizeIban('not an iban')).toBeNull();
  });
});

const business = { name: 'Schoon BV', legalName: 'Schoon Holding B.V.', kvkNumber: '12345678', vatNumber: 'NL123456789B01', invoiceIban: 'NL91ABNA0417164300', vatRateBps: 2100, currency: 'eur', timezone: 'Europe/Amsterdam' };
const booking = (over = {}) => ({
  id: 'bk1', businessId: 'biz', customerId: 'c1', status: 'COMPLETED', quotedPriceCents: 12100, paymentStatus: 'PAID',
  addressLine1: 'Damrak 1', addressLine2: null, postalCode: '1012 LG', city: 'Amsterdam',
  addOns: [{ name: 'Oven' }], service: { name: 'Standard clean', vatRateBps: null },
  customer: { firstName: 'Anna', lastName: 'de Vries', email: 'a@x.nl' }, business, ...over,
});

describe('issueForBooking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.invoice.findFirst.mockResolvedValue(null);
    prisma.booking.findFirst.mockResolvedValue(booking());
    prisma.businessAddress.findFirst.mockResolvedValue({ line1: 'Kalverstraat 1', postalCode: '1012 NX', city: 'Amsterdam', country: 'NL' });
    prisma.invoiceCounter.upsert.mockResolvedValue({ lastSequence: 42 });
    prisma.invoice.create.mockImplementation(async ({ data }) => ({ id: 'inv1', ...data }));
  });

  test('issues a consecutive number, extracts BTW, snapshots supplier and customer', async () => {
    const inv = await svc.issueForBooking('biz', 'bk1', 'u1');
    expect(prisma.invoiceCounter.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { lastSequence: { increment: 1 } } }));
    expect(inv.sequence).toBe(42);
    expect(inv.number).toMatch(/^\d{4}-00042$/);
    expect(inv).toMatchObject({ grossCents: 12100, netCents: 10000, vatCents: 2100, vatRateBps: 2100, currency: 'eur' });
    expect(inv.supplier).toMatchObject({ name: 'Schoon Holding B.V.', tradeName: 'Schoon BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01' });
    expect(inv.customerSnapshot).toMatchObject({ name: 'Anna de Vries', address: { line1: 'Damrak 1' } });
    expect(inv.lines).toEqual([expect.objectContaining({ description: 'Standard clean (incl. Oven)', grossCents: 12100 })]);
    expect(inv.paidAt).toBeInstanceOf(Date); // booking already PAID
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'INVOICE_ISSUED' }));
  });

  test('is idempotent: an existing invoice is returned untouched, no number is consumed', async () => {
    prisma.invoice.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(svc.issueForBooking('biz', 'bk1', 'u1')).resolves.toEqual({ id: 'existing' });
    expect(prisma.invoiceCounter.upsert).not.toHaveBeenCalled();
  });

  test('refuses without KvK/BTW-id, for cancelled bookings and for zero-price bookings', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ business: { ...business, vatNumber: null } }));
    await expect(svc.issueForBooking('biz', 'bk1', 'u')).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/KvK/) });
    prisma.booking.findFirst.mockResolvedValue(booking({ status: 'CANCELLED' }));
    await expect(svc.issueForBooking('biz', 'bk1', 'u')).rejects.toMatchObject({ status: 422 });
    prisma.booking.findFirst.mockResolvedValue(booking({ quotedPriceCents: 0 }));
    await expect(svc.issueForBooking('biz', 'bk1', 'u')).rejects.toMatchObject({ status: 422 });
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  test('a service-level 9% rate is used on the invoice', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ quotedPriceCents: 10900, service: { name: 'X', vatRateBps: 900 } }));
    const inv = await svc.issueForBooking('biz', 'bk1', 'u');
    expect(inv).toMatchObject({ vatRateBps: 900, vatCents: 900, netCents: 10000 });
  });

  test('two concurrent issuers: the loser (unique violation) returns the winner invoice', async () => {
    prisma.invoice.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'winner' });
    prisma.invoice.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    await expect(svc.issueForBooking('biz', 'bk1', 'u')).resolves.toEqual({ id: 'winner' });
  });

  test('unpaid booking -> invoice not marked paid', async () => {
    prisma.booking.findFirst.mockResolvedValue(booking({ paymentStatus: 'UNPAID' }));
    expect((await svc.issueForBooking('biz', 'bk1', 'u')).paidAt).toBeNull();
  });
});

describe('printable HTML', () => {
  const inv = {
    number: '2026-00042', currency: 'eur', vatRateBps: 2100, netCents: 10000, vatCents: 2100, grossCents: 12100,
    issuedAt: new Date('2026-06-15T10:00:00Z'), paidAt: null,
    supplier: { name: 'Schoon <b>BV</b>', kvkNumber: '12345678', vatNumber: 'NL123456789B01', address: { line1: 'K 1', postalCode: '1012', city: 'A', country: 'NL' } },
    customerSnapshot: { name: '<script>alert(1)</script>', address: { line1: '"><img src=x onerror=alert(1)>', city: 'A' } },
    lines: [{ description: '</td><script>x()</script>', quantity: 1, netCents: 10000, vatRateBps: 2100, grossCents: 12100 }],
  };
  test('carries its own CSP so a blob: copy on the app origin can never run script', () => {
    const html = svc.renderInvoiceHtml(inv);
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
  });

  test('escapes every user-controlled value and shows the legally required fields', () => {
    const html = svc.renderInvoiceHtml(inv);
    expect(html).not.toMatch(/<script>|<img src=x/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    for (const needle of ['2026-00042', 'KvK: 12345678', 'BTW-id: NL123456789B01', 'Totaal excl. BTW', 'BTW 21%', 'Totaal incl. BTW']) {
      expect(html).toContain(needle);
    }
  });
});
