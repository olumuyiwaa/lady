const prisma = require('../../config/database');

async function generateSummary(businessId) {
  const totalBookings = await prisma.booking.count({ where: { businessId } });
  const byStatus = await prisma.booking.groupBy({ by: ['status'], where: { businessId }, _count: { _all: true } });
  const recent = await prisma.booking.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { customer: true, service: true },
  });
  return { totalBookings, byStatus, recent };
}

async function generateKPIs(businessId, { from, to } = {}) {
  const where = { businessId };
  if (from || to) {
    where.scheduledStart = {};
    if (from) where.scheduledStart.gte = new Date(from);
    if (to) where.scheduledStart.lte = new Date(to);
  }

  const total = await prisma.booking.count({ where });
  const completed = await prisma.booking.count({ where: { ...where, status: 'COMPLETED' } });
  const cancelled = await prisma.booking.count({ where: { ...where, status: 'CANCELLED' } });
  const noShows = await prisma.booking.count({
    where: {
      ...where,
      status: { in: ['CONFIRMED', 'ASSIGNED'] },
      scheduledEnd: { lt: new Date() },
    },
  });
  const completionRate = total === 0 ? 0 : Math.round((completed / total) * 10000) / 100;
  const cancelRate = total === 0 ? 0 : Math.round((cancelled / total) * 10000) / 100;

  const revenueAgg = await prisma.booking.aggregate({
    where: { ...where, status: 'COMPLETED' },
    _sum: { quotedPriceCents: true },
  });
  const revenueCents = revenueAgg._sum.quotedPriceCents || 0;

  const paidAgg = await prisma.booking.aggregate({
    where: { ...where, paymentStatus: 'PAID' },
    _sum: { quotedPriceCents: true },
  });
  const collectedCents = paidAgg._sum.quotedPriceCents || 0;

  const bookingsPerCleaner = await prisma.bookingAssignment.groupBy({
    by: ['cleanerId'],
    where: { booking: where },
    _count: { bookingId: true },
  });

  const activeCleaners = await prisma.cleanerProfile.count({ where: { businessId, status: 'ACTIVE' } });
  const totalCustomers = await prisma.customer.count({ where: { businessId } });
  const repeatCustomers = await prisma.customer.count({
    where: { businessId, bookings: { some: {} } },
  });

  const completedJobs = await prisma.booking.findMany({
    where: { ...where, status: 'COMPLETED' },
    select: { scheduledStart: true, scheduledEnd: true },
  });
  const workedMinutes = completedJobs.reduce((sum, b) => {
    const ms = new Date(b.scheduledEnd) - new Date(b.scheduledStart);
    return sum + (ms > 0 ? ms / 60000 : 0);
  }, 0);

  let periodDays = 30;
  if (from && to) {
    periodDays = Math.max(1, Math.ceil((new Date(to) - new Date(from)) / 86400000));
  }
  const capacityMinutes = activeCleaners * periodDays * 8 * 60;
  const utilizationPct = capacityMinutes === 0 ? 0 : Math.round((workedMinutes / capacityMinutes) * 10000) / 100;

  const avgTicketCents = completed === 0 ? 0 : Math.round(revenueCents / completed);

  return {
    total,
    completed,
    cancelled,
    noShows,
    completionRate,
    cancelRate,
    revenueCents,
    collectedCents,
    avgTicketCents,
    bookingsPerCleaner,
    activeCleaners,
    totalCustomers,
    repeatCustomers,
    workedMinutes: Math.round(workedMinutes),
    utilizationPct,
  };
}

async function revenueByDay(businessId, { from, to } = {}) {
  const where = { businessId, status: 'COMPLETED' };
  if (from || to) {
    where.scheduledStart = {};
    if (from) where.scheduledStart.gte = new Date(from);
    if (to) where.scheduledStart.lte = new Date(to);
  }
  const bookings = await prisma.booking.findMany({
    where,
    select: { scheduledStart: true, quotedPriceCents: true },
    orderBy: { scheduledStart: 'asc' },
  });
  const byDay = {};
  for (const b of bookings) {
    const day = new Date(b.scheduledStart).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + (b.quotedPriceCents || 0);
  }
  return Object.entries(byDay).map(([date, revenueCents]) => ({ date, revenueCents }));
}

async function cleanerPerformance(businessId, { from, to } = {}) {
  const bookingWhere = { businessId };
  if (from || to) {
    bookingWhere.scheduledStart = {};
    if (from) bookingWhere.scheduledStart.gte = new Date(from);
    if (to) bookingWhere.scheduledStart.lte = new Date(to);
  }
  const cleaners = await prisma.cleanerProfile.findMany({
    where: { businessId, status: { in: ['ACTIVE', 'OFFBOARDED', 'SUSPENDED'] } },
    include: { user: { select: { firstName: true, lastName: true, email: true } } },
  });
  const results = [];
  for (const c of cleaners) {
    const assignments = await prisma.bookingAssignment.findMany({
      where: { cleanerId: c.id, booking: bookingWhere },
      include: { booking: true },
    });
    const completed = assignments.filter((a) => a.booking.status === 'COMPLETED').length;
    const revenueCents = assignments
      .filter((a) => a.booking.status === 'COMPLETED')
      .reduce((s, a) => s + (a.booking.quotedPriceCents || 0), 0);
    const onTimeCheckins = assignments.filter((a) => a.checkedInAt).length;
    
    // Quality: customer ratings tied directly to this cleaner via Review.cleanerId
    const reviewWhere = { cleanerId: c.id };
    if (from || to) {
      reviewWhere.createdAt = {};
      if (from) reviewWhere.createdAt.gte = new Date(from);
      if (to) reviewWhere.createdAt.lte = new Date(to);
    }
    const reviewAgg = await prisma.review.aggregate({
      where: reviewWhere,
      _avg: { rating: true },
      _count: { rating: true },
    });
    const lowRatings = await prisma.review.count({ where: { ...reviewWhere, rating: { lte: 2 } } });

    results.push({
      cleanerId: c.id,
      name: `${c.user.firstName} ${c.user.lastName}`,
      email: c.user.email,
      status: c.status,
      jobs: assignments.length,
      completed,
      revenueCents,
      checkIns: onTimeCheckins,
      avgRating: reviewAgg._avg.rating != null ? Math.round(reviewAgg._avg.rating * 100) / 100 : null,
      reviewCount: reviewAgg._count.rating,
      lowRatingCount: lowRatings,
    });
  }
  results.sort((a, b) => b.revenueCents - a.revenueCents);
  return results;
}

/**
 * Audit trail for the dashboard page.
 * Maps Prisma AuditLog → shape expected by frontend
 * (action, resource, resourceId, user, previousData, newData, ipAddress).
 */
async function auditTrail(businessId, { page = 1, limit = 20, from, to, userId, resource, action } = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

  const where = { businessId };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      where.createdAt.lte = end;
    }
  }
  if (userId) where.actorUserId = userId;
  if (resource) where.entityType = resource;
  if (action) where.action = { contains: action, mode: 'insensitive' };

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        actor: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    }),
  ]);

  const data = rows.map((row) => {
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    return {
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      resource: row.entityType,
      resourceId: row.entityId,
      ipAddress: meta.ipAddress || meta.ip || null,
      user: row.actor
        ? {
            email: row.actor.email,
            role: meta.role || null,
            name: `${row.actor.firstName || ''} ${row.actor.lastName || ''}`.trim(),
          }
        : null,
      previousData: meta.previousData || meta.before || null,
      newData: meta.newData || meta.after || (Object.keys(meta).length ? meta : null),
    };
  });

  return {
    data,
    pagination: {
      page: Math.max(parseInt(page, 10) || 1, 1),
      limit: take,
      total,
      totalPages: Math.ceil(total / take) || 1,
    },
  };
}


/**
 * Rolls KPIs up across every location under a franchise parent, plus the
 * per-location breakdown so an owner can see which branch is driving (or
 * dragging) the aggregate. Locations remain operationally independent —
 * this is a read-only summary, not a merged dataset.
 */
async function orgSummary(parentBusinessId, { from, to } = {}) {
  const locations = await prisma.business.findMany({
    where: { parentBusinessId },
    select: { id: true, name: true, subdomain: true },
  });

  const perLocation = await Promise.all(
    locations.map(async (loc) => ({
      businessId: loc.id,
      name: loc.name,
      subdomain: loc.subdomain,
      kpis: await generateKPIs(loc.id, { from, to }),
    }))
  );

  const totals = perLocation.reduce(
    (acc, l) => ({
      total: acc.total + l.kpis.total,
      completed: acc.completed + l.kpis.completed,
      cancelled: acc.cancelled + l.kpis.cancelled,
      revenueCents: acc.revenueCents + l.kpis.revenueCents,
      collectedCents: acc.collectedCents + l.kpis.collectedCents,
      activeCleaners: acc.activeCleaners + l.kpis.activeCleaners,
      totalCustomers: acc.totalCustomers + l.kpis.totalCustomers,
    }),
    { total: 0, completed: 0, cancelled: 0, revenueCents: 0, collectedCents: 0, activeCleaners: 0, totalCustomers: 0 }
  );

  return { locationCount: locations.length, totals, locations: perLocation };
}

module.exports = {
  orgSummary,
  generateSummary,
  generateKPIs,
  revenueByDay,
  cleanerPerformance,
  auditTrail,
};
