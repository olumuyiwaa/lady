/**
 * iCalendar (RFC 5545) rendering for booking feeds. Pure functions, no I/O.
 */

const pad = (n) => String(n).padStart(2, '0');

/** 2026-10-10T08:00:00Z -> 20261010T080000Z */
function icsDate(d) {
  const x = new Date(d);
  return (
    `${x.getUTCFullYear()}${pad(x.getUTCMonth() + 1)}${pad(x.getUTCDate())}` +
    `T${pad(x.getUTCHours())}${pad(x.getUTCMinutes())}${pad(x.getUTCSeconds())}Z`
  );
}

/** TEXT values: escape backslash, semicolon, comma and newlines. */
function escapeText(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Lines must not exceed 75 OCTETS. Fold by bytes without splitting a
 * multi-byte character (names and streets contain accents), continuing with a
 * leading space.
 */
function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
      limit = 74; // continuation lines start with one space
    }
    current += ch;
    bytes += b;
  }
  if (current) parts.push(current);
  return parts.join('\r\n ');
}

const STATUS = { CANCELLED: 'CANCELLED', REQUESTED: 'TENTATIVE' };

const fullName = (c) => (c ? `${c.firstName || ''} ${c.lastName || ''}`.trim() : '');

/**
 * @param {object}  opts
 * @param {string}  opts.name        calendar display name
 * @param {Array}   opts.bookings    booking rows with customer, service, assignments
 * @param {boolean} opts.forCleaner  cleaner feed: first name only, no phone number
 * @param {Date}    [opts.now]
 */
function renderFeed({ name, bookings, forCleaner = false, now = new Date() }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lady Greener//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const b of bookings) {
    const service = b.service?.name || 'Cleaning';
    const customer = forCleaner ? b.customer?.firstName || '' : fullName(b.customer);
    const where = [b.addressLine1, b.addressLine2, [b.postalCode, b.city].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ');

    const cleanerNames = (b.assignments || []).map((a) => fullName(a.cleaner?.user)).filter(Boolean).join(', ');

    const description = [
      customer && `Customer: ${customer}`,
      !forCleaner && b.customer?.phone && `Phone: ${b.customer.phone}`,
      !forCleaner && cleanerNames && `Cleaner: ${cleanerNames}`,
      b.specialInstructions && `Notes: ${b.specialInstructions}`,
      b.parkingInstructions && `Parking: ${b.parkingInstructions}`,
      b.petNotes && `Pets: ${b.petNotes}`,
      // Calendar apps sync to third-party servers, so a door code never goes in here.
      b.accessCode && 'Access code: see the Lady Greener app',
    ]
      .filter(Boolean)
      .join('\n');

    const modified = b.updatedAt || b.createdAt || now;
    lines.push(
      'BEGIN:VEVENT',
      `UID:booking-${b.id}@ladygreener`,
      `DTSTAMP:${icsDate(now)}`,
      `LAST-MODIFIED:${icsDate(modified)}`,
      // Lets calendar apps recognise a changed event with the same UID as an update.
      `SEQUENCE:${Math.floor(new Date(modified).getTime() / 1000)}`,
      `DTSTART:${icsDate(b.scheduledStart)}`,
      `DTEND:${icsDate(b.scheduledEnd || new Date(new Date(b.scheduledStart).getTime() + 2 * 3600 * 1000))}`,
      `SUMMARY:${escapeText(customer ? `${service} · ${customer}` : service)}`,
      ...(where ? [`LOCATION:${escapeText(where)}`] : []),
      ...(description ? [`DESCRIPTION:${escapeText(description)}`] : []),
      `STATUS:${STATUS[b.status] || 'CONFIRMED'}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = { renderFeed, icsDate, escapeText, foldLine };
