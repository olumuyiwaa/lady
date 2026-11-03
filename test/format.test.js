const { formatDateTime, formatMoney } = require('../src/utils/format');

describe('format', () => {
  test('renders a UTC instant in the business timezone, in Dutch, not as a raw Date string', () => {
    const out = formatDateTime(new Date('2026-09-21T08:00:00Z'), { timeZone: 'Europe/Amsterdam' });
    expect(out).toContain('10:00'); // CEST is UTC+2
    expect(out.toLowerCase()).toContain('september');
    expect(out).not.toContain('GMT');
  });

  test('the same instant reads differently in another timezone', () => {
    expect(formatDateTime(new Date('2026-09-21T08:00:00Z'), { timeZone: 'Africa/Lagos' })).toContain('09:00');
  });

  test('invalid dates give an empty string rather than "Invalid Date"', () => {
    expect(formatDateTime('nope')).toBe('');
  });

  test('money uses the business currency and Dutch formatting', () => {
    expect(formatMoney(12345, 'eur')).toMatch(/123,45/);
    expect(formatMoney(12345, 'eur')).toContain('€');
  });
});
