jest.mock('../src/config/database', () => ({
  customer: { findFirst: jest.fn() },
  business: { findUnique: jest.fn() },
  booking: { findMany: jest.fn() },
  invoice: { findMany: jest.fn() },
}));
const prisma = require('../src/config/database');
const acct = require('../src/lib/b2bAccount');
const svc = require('../src/modules/b2b/b2b.service');

describe('cleanB2bFields', () => {
  test('normalises and validates', () => {
    expect(acct.cleanB2bFields({ companyName: '  Acme   BV ', kvkNumber: '1234 5678', vatNumber: 'nl 1234.56.789 b01', billingEmail: ' AP@Acme.NL ', paymentTermsDays: '30' }))
      .toEqual({ companyName: 'Acme BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01', billingEmail: 'ap@acme.nl', paymentTermsDays: 30 });
  });
  test('only touches provided keys; empty clears', () => {
    expect(acct.cleanB2bFields({})).toEqual({});
    expect(acct.cleanB2bFields({ companyName: '', paymentTermsDays: null })).toEqual({ companyName: null, paymentTermsDays: null });
  });
  test.each([[{ kvkNumber: '123' }], [{ vatNumber: '12' }], [{ billingEmail: 'nope' }], [{ paymentTermsDays: -1 }], [{ paymentTermsDays: 1.5 }], [{ paymentTermsDays: 500 }]])('rejects %j', (bad) => {
    expect(() => acct.cleanB2bFields(bad)).toThrow(expect.objectContaining({ status: 422 }));
  });
});

describe('helpers', () => {
  test('dueDateFor only for business accounts with terms', () => {
    const issued = new Date('2026-11-01T00:00:00Z');
    expect(acct.dueDateFor({ companyName: 'A', paymentTermsDays: 30 }, issued).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(acct.dueDateFor({ companyName: null, paymentTermsDays: 30 }, issued)).toBeNull();
    expect(acct.dueDateFor({ companyName: 'A', paymentTermsDays: 0 }, issued)).toBeNull();
  });
  test('invoiceName uses the company when set', () => {
    expect(acct.invoiceName({ firstName: 'Ann', lastName: 'B', companyName: 'Acme BV' })).toBe('Acme BV');
    expect(acct.invoiceName({ firstName: 'Ann', lastName: 'B' })).toBe('Ann B');
  });
  test('locationKey ignores case, spacing and postcode spaces', () => {
    expect(acct.locationKey({ postalCode: '1011 AB', addressLine1: 'Dam  1', city: 'Amsterdam' })).toBe(
      acct.locationKey({ postalCode: '1011ab', addressLine1: 'dam 1', city: 'AMSTERDAM' })
    );
  });
  test('monthRange respects the timezone (winter and summer)', () => {
    expect(acct.monthRange('2026-11', 'Europe/Amsterdam').from.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(acct.monthRange('2026-07', 'Europe/Amsterdam').from.toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(acct.monthRange('2026-12', 'Europe/Amsterdam').to.toISOString()).toBe('2026-12-31T23:00:00.000Z');
    expect(acct.monthRange('2026-01').previous).toBe('2025-12');
    expect(acct.monthRange('garbage', 'Europe/Amsterdam', new Date('2026-11-05T10:00:00Z')).month).toBe('2026-11');
  });
  test('csv quotes cells and neutralises formulas', () => {
    expect(acct.csvCell('a,b')).toBe('"a,b"');
    expect(acct.csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(acct.csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(acct.toCsv([['a', 1]])).toBe('﻿a,1\r\n');
  });
});

const b = (o) => ({ addressLine1: 'Dam 1', postalCode: '1011AB', city: 'Amsterdam', quotedPriceCents: 10000, travelFeeCents: 500, status: 'COMPLETED',
  scheduledStart: new Date('2026-11-03T08:00:00Z'), scheduledEnd: new Date('2026-11-03T10:00:00Z'), service: { name: 'Office' }, ...o });

describe('aggregate / invoiceFigures', () => {
  test('groups by location and service', () => {
    const r = svc.aggregate([b(), b(), b({ addressLine1: 'Rokin 5', postalCode: '1012AA', quotedPriceCents: 5000, service: { name: 'Windows' } })]);
    expect(r).toMatchObject({ visits: 3, completedVisits: 3, spendCents: 25000, travelCents: 1500, hours: 6 });
    expect(r.locations[0]).toMatchObject({ label: 'Dam 1, 1011AB Amsterdam', visits: 2, spendCents: 20000, hours: 4 });
    expect(r.services.map((s) => s.name)).toEqual(['Office', 'Windows']);
  });
  test('open vs overdue', () => {
    const now = new Date('2026-11-10T00:00:00Z').getTime();
    const r = svc.invoiceFigures([
      { grossCents: 100, paidAt: null, dueAt: new Date('2026-11-01') },
      { grossCents: 200, paidAt: null, dueAt: new Date('2026-12-01') },
      { grossCents: 400, paidAt: new Date(), dueAt: new Date('2026-10-01') },
    ].filter(Boolean).filter((i) => !i.paidAt || true), now);
    expect(r).toMatchObject({ openCount: 2, openCents: 300, overdueCount: 1, overdueCents: 100 });
  });
});

describe('service access and exports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.business.findUnique.mockResolvedValue({ timezone: 'Europe/Amsterdam', currency: 'eur', name: 'Tod' });
    prisma.customer.findFirst.mockResolvedValue({ id: 'c', companyName: 'Acme BV', vatNumber: 'NL1', paymentTermsDays: 30 });
    prisma.booking.findMany.mockResolvedValue([b({ invoice: { number: '2026-0001', paidAt: null } })]);
    prisma.invoice.findMany.mockResolvedValue([]);
  });

  test('private customers get 403', async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: 'c', companyName: null });
    await expect(svc.getSummary('biz', 'c', '2026-11')).rejects.toMatchObject({ status: 403 });
    await expect(svc.exportVisitsCsv('biz', 'c', { from: '2026-11-01', to: '2026-12-01' })).rejects.toMatchObject({ status: 403 });
  });

  test('summary is scoped to the customer and month', async () => {
    const r = await svc.getSummary('biz', 'c', '2026-11');
    expect(r).toMatchObject({ month: '2026-11', visits: 1, spendCents: 10000, company: { name: 'Acme BV', paymentTermsDays: 30 } });
    const where = prisma.booking.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ businessId: 'biz', customerId: 'c' });
    expect(where.scheduledStart.gte.toISOString()).toBe('2026-10-31T23:00:00.000Z');
  });

  test('csv has a header, a row and validates the range', async () => {
    const csv = await svc.exportVisitsCsv('biz', 'c', { from: '2026-11-01', to: '2026-12-01' });
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('Date,Location,Service,Status,Hours,Travel fee,Total incl. VAT,Invoice,Paid');
    expect(lines[1]).toContain('Office');
    expect(lines[1]).toContain('100.00');
    expect(lines[1]).toContain('no');
    await expect(svc.exportVisitsCsv('biz', 'c', { from: 'x', to: 'y' })).rejects.toMatchObject({ status: 422 });
    await expect(svc.exportVisitsCsv('biz', 'c', { from: '2024-01-01', to: '2026-01-01' })).rejects.toMatchObject({ status: 422 });
  });

  test('statement escapes company names', async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: 'c', companyName: '<script>x</script>' });
    prisma.invoice.findMany.mockResolvedValue([{ number: 'N1', issuedAt: new Date(), dueAt: null, paidAt: null, grossCents: 1210 }]);
    const html = await svc.renderStatementHtml('biz', 'c', '2026-11');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Open');
  });
});
