/**
 * Staff view of business (B2B) accounts: every company the business serves,
 * with its quality figures for a month, the detailed per-branch report and PDF,
 * and the company's team members. Reuses the portal's report builders so a
 * manager and the customer always see the same numbers.
 */
const prisma = require('../../config/database');
const b2b = require('../../lib/b2bAccount');
const { buildQualityReport } = require('../../lib/qualityReport');
const b2bService = require('../b2b/b2b.service');
const members = require('../b2b/members.service');

const MAX_ACCOUNTS = 500;
const label = (b) => [b.addressLine1, [b.postalCode, b.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');

async function timeZoneOf(businessId) {
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } });
  return (biz && biz.timezone) || 'Europe/Amsterdam';
}

/** All business accounts with the month's headline quality numbers. */
async function list(businessId, month) {
  const range = b2b.monthRange(month, await timeZoneOf(businessId));
  const customers = await prisma.customer.findMany({
    where: { businessId, companyName: { not: null } },
    select: { id: true, companyName: true, firstName: true, lastName: true, email: true, phone: true, paymentTermsDays: true },
    orderBy: { companyName: 'asc' },
    take: MAX_ACCOUNTS,
  });
  const ids = customers.map((c) => c.id);
  if (!ids.length) return { month: range.month, accounts: [] };

  const [bookings, memberRows, unpaid] = await Promise.all([
    prisma.booking.findMany({
      where: { businessId, customerId: { in: ids }, status: { not: 'CANCELLED' }, scheduledStart: { gte: range.from, lt: range.to } },
      include: { review: { select: { rating: true } }, checklist: { select: { items: true } }, assignments: { select: { checkedInAt: true } } },
      take: 20000,
    }),
    prisma.companyMember.findMany({ where: { businessId, customerId: { in: ids }, isActive: true }, select: { customerId: true }, take: 10000 }),
    prisma.invoice.findMany({ where: { businessId, customerId: { in: ids }, paidAt: null }, select: { customerId: true, grossCents: true, dueAt: true }, take: 20000 }),
  ]);
  const tickets = bookings.length
    ? await prisma.supportTicket.findMany({ where: { businessId, kind: 'COMPLAINT', bookingId: { in: bookings.map((b) => b.id) } }, select: { bookingId: true }, take: 20000 })
    : [];
  const complaintsBy = new Map();
  for (const t of tickets) complaintsBy.set(t.bookingId, (complaintsBy.get(t.bookingId) || 0) + 1);

  const group = (rows, key) => {
    const m = new Map();
    for (const r of rows) m.set(r[key], [...(m.get(r[key]) || []), r]);
    return m;
  };
  const bookingsBy = group(bookings, 'customerId');
  const membersBy = group(memberRows, 'customerId');
  const unpaidBy = group(unpaid, 'customerId');
  const now = Date.now();

  const accounts = customers.map((c) => {
    const mine = bookingsBy.get(c.id) || [];
    const q = buildQualityReport(mine, complaintsBy, label);
    const owed = unpaidBy.get(c.id) || [];
    return {
      customerId: c.id,
      companyName: c.companyName,
      contactName: [c.firstName, c.lastName].filter(Boolean).join(' '),
      email: c.email,
      phone: c.phone,
      branchCount: q.branches.length,
      memberCount: (membersBy.get(c.id) || []).length,
      spendCents: mine.reduce((a, b) => a + (b.quotedPriceCents || 0), 0),
      openInvoiceCents: owed.reduce((a, i) => a + i.grossCents, 0),
      overdueInvoices: owed.filter((i) => i.dueAt && new Date(i.dueAt).getTime() < now).length,
      quality: q.total,
    };
  });
  return { month: range.month, graceMinutes: 10, accounts };
}

/** Full per-branch report of one account (same shape as the portal's). */
const quality = (businessId, customerId, month) => b2bService.getQualityReport(businessId, customerId, month);
const qualityPdf = (businessId, customerId, month) => b2bService.renderQualityPdfFor(businessId, customerId, month);

module.exports = {
  list,
  quality,
  qualityPdf,
  listMembers: members.list,
  listLocations: members.listLocations,
  createMember: members.create,
  updateMember: (businessId, customerId, memberId, input) => members.update(businessId, customerId, memberId, input),
  removeMember: (businessId, customerId, memberId) => members.deactivate(businessId, customerId, memberId),
};
