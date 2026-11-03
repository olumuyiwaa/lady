const prisma = require('../../config/database');

const STATUS_COLOR = {
  REQUESTED: '#94a3b8',
  CONFIRMED: '#3b82f6',
  ASSIGNED: '#8b5cf6',
  IN_PROGRESS: '#f59e0b',
  COMPLETED: '#22c55e',
  CANCELLED: '#ef4444',
};

/**
 * Returns FullCalendar-ready events for the business between from/to.
 * Types: BOOKING | RECURRING (marker for nextRunDate of active schedules)
 */
async function listEvents(businessId, { from, to, types } = {}) {
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const toDate = to ? new Date(to) : new Date(Date.now() + 60 * 86400000);

  const wantBooking = !types || types.length === 0 || types.includes('BOOKING');
  const wantRecurring = !types || types.length === 0 || types.includes('RECURRING');

  const events = [];

  if (wantBooking) {
    const bookings = await prisma.booking.findMany({
      where: {
        businessId,
        scheduledStart: { gte: fromDate, lte: toDate },
      },
      include: {
        customer: true,
        service: true,
        assignments: { include: { cleaner: { include: { user: true } } } },
      },
      orderBy: { scheduledStart: 'asc' },
      take: 500,
    });

    for (const b of bookings) {
      const customerName = b.customer
        ? `${b.customer.firstName} ${b.customer.lastName}`.trim()
        : 'Customer';
      const serviceName = b.service?.name || 'Cleaning';
      const cleanerNames = (b.assignments || [])
        .map((a) => {
          const u = a.cleaner?.user;
          return u ? `${u.firstName} ${u.lastName}`.trim() : null;
        })
        .filter(Boolean);

      events.push({
        id: `BOOKING:${b.id}`,
        type: 'BOOKING',
        title: `${serviceName} · ${customerName}`,
        start: b.scheduledStart.toISOString(),
        end: b.scheduledEnd ? b.scheduledEnd.toISOString() : null,
        allDay: false,
        color: STATUS_COLOR[b.status] || '#3b82f6',
        status: b.status,
        resourceId: b.id,
        businessId,
        meta: {
          customerName,
          serviceName,
          address: [b.addressLine1, b.city, b.state].filter(Boolean).join(', '),
          cleaners: cleanerNames,
          quotedPriceCents: b.quotedPriceCents,
          paymentStatus: b.paymentStatus,
          cancelReason: b.cancelReason,
        },
      });
    }
  }

  if (wantRecurring) {
    const schedules = await prisma.recurringSchedule.findMany({
      where: {
        businessId,
        // RecurringSchedule has no `isActive` boolean — it uses the
        // `status` enum (ACTIVE/PAUSED/CANCELLED), same as everywhere
        // else this model is queried (bookings.service.js, recurringWorker.js).
        status: 'ACTIVE',
        nextRunDate: { gte: fromDate, lte: toDate },
      },
      include: { customer: true, service: true },
      take: 200,
    });

    for (const r of schedules) {
      const customerName = r.customer
        ? `${r.customer.firstName} ${r.customer.lastName}`.trim()
        : 'Customer';
      const serviceName = r.service?.name || 'Recurring clean';
      const start = new Date(r.nextRunDate);

      events.push({
        id: `RECURRING:${r.id}`,
        type: 'RECURRING',
        title: `↻ ${serviceName} · ${customerName}`,
        start: start.toISOString(),
        end: null,
        allDay: false,
        color: '#6366f1',
        status: 'ACTIVE',
        resourceId: r.id,
        businessId,
        meta: {
          customerName,
          serviceName,
          frequency: r.frequency,
          dayOfWeek: r.dayOfWeek,
          startTime: r.startTime,
          nextRunDate: r.nextRunDate?.toISOString?.() || r.nextRunDate,
        },
      });
    }
  }

  return events;
}

module.exports = { listEvents };
