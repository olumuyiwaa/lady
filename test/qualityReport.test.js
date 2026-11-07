const { buildQualityReport } = require('../src/lib/qualityReport');
const { renderQualityPdf } = require('../src/modules/b2b/quality.pdf');

const at = (h, m = 0) => new Date(Date.UTC(2026, 10, 3, h, m));
const visit = (id, addr, over = {}) => ({
  id, addressLine1: addr, postalCode: '1011 AA', city: 'Amsterdam', status: 'COMPLETED',
  scheduledStart: at(9), scheduledEnd: at(11),
  review: null, checklist: null, assignments: [{ checkedInAt: at(9, 5) }], ...over,
});

describe('buildQualityReport', () => {
  test('groups by branch and computes the four measures', () => {
    const bookings = [
      visit('a1', 'Dam 1', { review: { rating: 5 }, checklist: { items: [{ done: true }, { done: true }] } }),
      visit('a2', 'Dam 1', { review: { rating: 4 }, checklist: { items: [{ done: true }, { done: false }] }, assignments: [{ checkedInAt: at(9, 30) }] }),
      visit('b1', 'Spui 2', { assignments: [] }),
      visit('b2', 'Spui 2', { status: 'CONFIRMED' }),
    ];
    const r = buildQualityReport(bookings, new Map([['a2', 2]]), (b) => b.addressLine1);
    const dam = r.branches.find((b) => b.label === 'Dam 1');
    expect(dam).toMatchObject({ visits: 2, completedVisits: 2, averageRating: 4.5, ratingCount: 2, checklistCompletionPct: 75, punctualityPct: 50, complaints: 2 });
    const spui = r.branches.find((b) => b.label === 'Spui 2');
    expect(spui).toMatchObject({ visits: 2, completedVisits: 1, averageRating: null, checklistCompletionPct: null, punctualityPct: null, noCheckIn: 1 });
    expect(r.total).toMatchObject({ visits: 4, complaints: 2, averageRating: 4.5 });
  });

  test('the same address typed differently is one branch', () => {
    const r = buildQualityReport([visit('1', 'Dam 1'), visit('2', ' dam  1 ')]);
    expect(r.branches).toHaveLength(1);
  });

  test('check-in exactly at the grace limit counts as on time', () => {
    const r = buildQualityReport([visit('1', 'Dam 1', { assignments: [{ checkedInAt: at(9, 10) }] })]);
    expect(r.total.punctualityPct).toBe(100);
  });

  test('empty month', () => {
    const r = buildQualityReport([]);
    expect(r.branches).toEqual([]);
    expect(r.total.visits).toBe(0);
  });
});

describe('renderQualityPdf', () => {
  test.each(['nl', 'en'])('produces a PDF in %s', async (language) => {
    const report = buildQualityReport([visit('1', 'Dam 1', { review: { rating: 5 } }), visit('2', 'Spui 2')], new Map(), (b) => b.addressLine1);
    const buf = await renderQualityPdf({ report, month: '2026-11', companyName: 'Acme BV', businessName: 'Tod Cleaning Services', language });
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(1500);
  });
  test('an empty report still renders', async () => {
    const buf = await renderQualityPdf({ report: buildQualityReport([]), month: '2026-11', companyName: 'Acme', businessName: 'Tod' });
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });
});
