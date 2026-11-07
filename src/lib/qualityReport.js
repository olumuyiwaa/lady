/**
 * Monthly quality figures for a business account, per branch (service address).
 * Pure: takes bookings already loaded with their review, checklist, assignments
 * and complaint tickets, and returns numbers. See b2b.service for the loading
 * and quality.pdf.js for the PDF.
 *
 * - Rating: average of customer reviews on completed visits (null when none).
 * - Checklist: ticked items / all items on the checklists of completed visits.
 * - Punctuality: share of visits where the first cleaner checked in no later
 *   than GRACE_MINUTES after the booked start. Visits with no check-in
 *   are left out of the percentage and counted as `noCheckIn`.
 * - Complaints: complaint tickets raised about the visits.
 */
const { locationKey } = require('./b2bAccount');

const GRACE_MINUTES = 10;
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

function emptyBucket(key, label) {
  return { key, label, visits: 0, completed: 0, ratingSum: 0, ratings: 0, itemsDone: 0, itemsTotal: 0, onTime: 0, timed: 0, noCheckIn: 0, complaints: 0 };
}

function finish(b) {
  return {
    key: b.key,
    label: b.label,
    visits: b.visits,
    completedVisits: b.completed,
    averageRating: b.ratings ? round1(b.ratingSum / b.ratings) : null,
    ratingCount: b.ratings,
    checklistCompletionPct: pct(b.itemsDone, b.itemsTotal),
    punctualityPct: pct(b.onTime, b.timed),
    noCheckIn: b.noCheckIn,
    complaints: b.complaints,
  };
}

function addVisit(bucket, booking, complaintCount) {
  bucket.visits += 1;
  bucket.complaints += complaintCount;
  if (booking.status !== 'COMPLETED') return;
  bucket.completed += 1;

  if (booking.review && Number.isFinite(booking.review.rating)) {
    bucket.ratingSum += booking.review.rating;
    bucket.ratings += 1;
  }
  const items = booking.checklist && Array.isArray(booking.checklist.items) ? booking.checklist.items : [];
  bucket.itemsTotal += items.length;
  bucket.itemsDone += items.filter((i) => i && i.done).length;

  const checkIns = (booking.assignments || []).map((a) => a.checkedInAt).filter(Boolean).map((d) => new Date(d).getTime());
  if (checkIns.length === 0) {
    bucket.noCheckIn += 1;
  } else {
    bucket.timed += 1;
    const limit = new Date(booking.scheduledStart).getTime() + GRACE_MINUTES * 60000;
    if (Math.min(...checkIns) <= limit) bucket.onTime += 1;
  }
}

/**
 * @param bookings non-cancelled bookings of the month
 * @param complaintsByBooking Map bookingId -> number of complaint tickets
 */
function buildQualityReport(bookings, complaintsByBooking = new Map(), labelOf = (b) => b.addressLine1 || '') {
  const branches = new Map();
  const total = emptyBucket('total', 'Total');
  for (const b of bookings) {
    const key = locationKey(b);
    if (!branches.has(key)) branches.set(key, emptyBucket(key, labelOf(b)));
    const n = complaintsByBooking.get(b.id) || 0;
    addVisit(branches.get(key), b, n);
    addVisit(total, b, n);
  }
  return {
    graceMinutes: GRACE_MINUTES,
    total: finish(total),
    branches: [...branches.values()].map(finish).sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label)),
  };
}

module.exports = { buildQualityReport, GRACE_MINUTES };
