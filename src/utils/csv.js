/**
 * Serializes an array of flat objects to CSV text. Column order follows the
 * keys of the first row, so callers should pass consistently-shaped rows
 * (both reports.service.js sources already return flat, uniform objects).
 */
function toCsv(rows) {
  if (!rows || rows.length === 0) return '';

  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    if (value == null) return '';
    const s = String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}

module.exports = { toCsv };
