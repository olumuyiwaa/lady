const { renderFeed, foldLine, escapeText, icsDate } = require('../src/modules/calendar/ics');

const NOW = new Date('2026-10-04T10:00:00Z');
const booking = (over = {}) => ({
  id: 'bk1', status: 'CONFIRMED',
  scheduledStart: new Date('2026-10-10T08:00:00Z'), scheduledEnd: new Date('2026-10-10T10:30:00Z'),
  updatedAt: new Date('2026-10-03T09:00:00Z'),
  addressLine1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam',
  customer: { firstName: 'Anna', lastName: 'de Vries', phone: '+31612345678' },
  service: { name: 'Deep clean' },
  assignments: [{ cleaner: { user: { firstName: 'Piet', lastName: 'Jansen' } } }],
  specialInstructions: 'Ring twice', accessCode: '4821', ...over,
});
const lines = (s) => s.replace(/\r\n /g, '').split('\r\n');

describe('renderFeed', () => {
  test('is a well-formed calendar with CRLF endings and a stable UID', () => {
    const out = renderFeed({ name: 'Schoon · Bookings', bookings: [booking()], now: NOW });
    expect(out.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(/[^\r]\n/.test(out)).toBe(false);
    const l = lines(out);
    expect(l).toContain('UID:booking-bk1@ladygreener');
    expect(l).toContain('DTSTART:20261010T080000Z');
    expect(l).toContain('DTEND:20261010T103000Z');
    expect(l).toContain('STATUS:CONFIRMED');
  });

  test('a door code is never written into the feed', () => {
    const out = renderFeed({ name: 'x', bookings: [booking()], now: NOW });
    expect(out).not.toContain('4821');
    expect(lines(out).join('\n')).toContain('Access code: see the Lady Greener app');
  });

  test('cleaner feeds show first name only and no phone number', () => {
    const l = lines(renderFeed({ name: 'x', bookings: [booking()], forCleaner: true, now: NOW })).join('\n');
    expect(l).toContain('SUMMARY:Deep clean · Anna');
    expect(l).not.toContain('de Vries');
    expect(l).not.toContain('+31612345678');
    expect(l).not.toContain('Cleaner:');
  });

  test('business feeds include full name, phone and assigned cleaner', () => {
    const l = lines(renderFeed({ name: 'x', bookings: [booking()], now: NOW })).join('\n');
    expect(l).toContain('Anna de Vries');
    expect(l).toContain('Phone: +31612345678');
    expect(l).toContain('Cleaner: Piet Jansen');
  });

  test('cancelled and requested bookings map to calendar statuses', () => {
    expect(renderFeed({ name: 'x', bookings: [booking({ status: 'CANCELLED' })], now: NOW })).toContain('STATUS:CANCELLED');
    expect(renderFeed({ name: 'x', bookings: [booking({ status: 'REQUESTED' })], now: NOW })).toContain('STATUS:TENTATIVE');
  });

  test('a missing end time defaults to two hours after the start', () => {
    const out = renderFeed({ name: 'x', bookings: [booking({ scheduledEnd: null })], now: NOW });
    expect(out).toContain('DTEND:20261010T100000Z');
  });

  test('an empty feed is still a valid calendar', () => {
    const out = renderFeed({ name: 'x', bookings: [], now: NOW });
    expect(out).toContain('BEGIN:VCALENDAR');
    expect(out).not.toContain('BEGIN:VEVENT');
  });
});

describe('text helpers', () => {
  test('escapes commas, semicolons, backslashes and newlines', () => {
    expect(escapeText('a, b; c\\d\ne')).toBe('a\\, b\\; c\\\\d\\ne');
  });
  test('formats UTC dates', () => {
    expect(icsDate('2026-01-02T03:04:05Z')).toBe('20260102T030405Z');
  });
  test('folds at 75 octets without splitting a multi-byte character', () => {
    const long = 'SUMMARY:' + 'é'.repeat(80);
    const folded = foldLine(long);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(75);
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(long); // nothing lost, no broken characters
  });
  test('short lines are left alone', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  });
});
