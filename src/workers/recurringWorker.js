const prisma = require('../config/database');
const logger = require('../config/logger');
const notifications = require('../modules/notifications/notifications.service');
const pricing = require('../lib/pricing');
const { advanceRunDate } = require('../utils/timezone');
const { getAccess } = require('../lib/subscriptionAccess');

/**
 * How far ahead recurring visits are materialised as real bookings.
 *
 * `RecurringSchedule.nextRunDate` is the start time of the next visit. The
 * worker used to pick up a schedule only once `nextRunDate <= now`, i.e. it
 * created each booking at (or after) the moment the job was supposed to
 * start - so dispatch could never assign it and the customer never saw it
 * coming. Bookings are now generated LOOKAHEAD days in advance.
 */
const DEFAULT_LOOKAHEAD_DAYS = 21;
// Safety valve: at most this many visits per schedule per tick (a weekly
// schedule with a 21-day window needs 3; this only matters after long outages).
const MAX_OCCURRENCES_PER_SCHEDULE = 8;

function lookaheadMs() {
  const d = Number(process.env.RECURRING_LOOKAHEAD_DAYS);
  return (Number.isFinite(d) && d > 0 ? d : DEFAULT_LOOKAHEAD_DAYS) * 24 * 60 * 60 * 1000;
}

const firstDefined = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '') ?? null;

/**
 * Builds the booking row for one occurrence. The previous version copied only
 * the address lines and priced every visit at service.basePriceCents, which
 * dropped add-ons, per-room/per-sqft inputs, the frequency discount, the
 * postcode and - most importantly for the cleaner - door codes and pet notes.
 *
 * `template` is the schedule's most recent booking, used only for what the
 * customer chose in the booking form (add-ons, home details). Its price is NOT
 * reused: it may include a one-off coupon or referral discount.
 */
async function buildOccurrence(s, address, template, start) {
  const homeDetails = (template && template.homeDetails) || {};
  const templateAddOnIds = Array.isArray(template && template.addOns) ? template.addOns.map((a) => a.id) : [];
  // Only add-ons that still exist on the service are carried forward.
  const currentAddOns = (s.service.addOns || []).filter((a) => templateAddOnIds.includes(a.id));

  const lat = firstDefined(address.latitude, template && template.latitude);
  const lng = firstDefined(address.longitude, template && template.longitude);
  const quote = await pricing.calculateQuote(s.service, {
    businessId: s.businessId,
    latitude: lat,
    longitude: lng,
    addOnIds: currentAddOns.map((a) => a.id),
    rooms: homeDetails.rooms,
    bathrooms: homeDetails.bathrooms,
    sqft: homeDetails.sqft,
    frequency: s.frequency,
  });

  const minutes = (quote.breakdown && quote.breakdown.estimatedMinutes) || s.service.estimatedMinutes || 60;
  const end = new Date(start.getTime() + minutes * 60 * 1000);

  const hasHome = Object.keys(homeDetails).length > 0;
  return {
    end,
    data: {
      businessId: s.businessId,
      customerId: s.customerId,
      serviceId: s.serviceId,
      recurringScheduleId: s.id,
      addressLine1: address.line1,
      addressLine2: address.line2 || null,
      city: address.city || '',
      state: address.state || '',
      postalCode: firstDefined(address.postalCode, template && template.postalCode),
      latitude: firstDefined(address.latitude, template && template.latitude),
      longitude: firstDefined(address.longitude, template && template.longitude),
      // Standing site info: the address is the source of truth, the template
      // booking only fills gaps (schedules created from the widget copy these
      // onto the address, but older ones may not have them).
      accessCode: firstDefined(address.accessCode, template && template.accessCode),
      keyLocation: firstDefined(address.keyLocation, template && template.keyLocation),
      parkingInstructions: firstDefined(address.parkingInstructions, template && template.parkingInstructions),
      petNotes: firstDefined(address.petNotes, template && template.petNotes),
      // One-off notes on the template ("dog is at the vet this week") must not repeat.
      specialInstructions: firstDefined(address.specialInstructions),
      // The answers to the business's own booking questions describe the home/customer,
      // so repeat visits inherit them (a required question must not go missing).
      customAnswers: template && template.customAnswers ? template.customAnswers : undefined,
      addOns: currentAddOns.length
        ? currentAddOns.map((a) => ({ id: a.id, name: a.name, priceCents: a.priceCents, extraMinutes: a.extraMinutes }))
        : undefined,
      homeDetails: hasHome ? { ...homeDetails, frequency: s.frequency } : undefined,
      scheduledStart: start,
      scheduledEnd: end,
      quotedPriceCents: quote.priceCents,
      travelFeeCents: quote.breakdown && quote.breakdown.travelFeeCents > 0 ? quote.breakdown.travelFeeCents : null,
      travelDistanceMeters: quote.breakdown && quote.breakdown.travelFeeCents > 0 ? quote.breakdown.travelDistanceMeters : null,
      status: 'REQUESTED',
      paymentStatus: 'UNPAID',
    },
  };
}

/** Processes one schedule: creates every occurrence inside the look-ahead window. */
async function processSchedule(s, now, horizon, stats) {
  if (!s.customer || !s.service || !s.business) {
    logger.error('Recurring schedule missing required relations, deactivating', { scheduleId: s.id });
    await prisma.recurringSchedule.update({ where: { id: s.id }, data: { status: 'CANCELLED' } });
    stats.errors += 1;
    return;
  }

  // A business whose subscription lapsed gets no new visits generated (and no
  // SMS/email costs). nextRunDate is left alone; past occurrences are skipped
  // when it comes back.
  const access = await getAccess(s.businessId);
  if (!access.allowed) {
    logger.info('Recurring schedule skipped: subscription not active', { scheduleId: s.id, state: access.state });
    stats.skipped += 1;
    return;
  }

  const timezone = s.business.timezone || 'UTC';
  const address =
    s.customerAddress ||
    (s.customer.addresses || []).find((a) => a.isPrimary) ||
    (s.customer.addresses || [])[0];

  let template = null;
  let cursor = new Date(s.nextRunDate);

  for (let i = 0; i < MAX_OCCURRENCES_PER_SCHEDULE && cursor <= horizon; i += 1) {
    const start = cursor;
    const nextRunDate = advanceRunDate(start, s.frequency, s.startTime, timezone);

    // Never create a visit in the past (e.g. after the daemon was down):
    // just move the schedule forward.
    if (start < now) {
      logger.warn('Recurring occurrence is in the past, skipped', { scheduleId: s.id, occurrenceStart: start.toISOString() });
      await prisma.recurringSchedule.update({ where: { id: s.id }, data: { nextRunDate } });
      stats.skipped += 1;
      cursor = nextRunDate;
      continue;
    }

    if (!address || !address.line1) {
      logger.warn('Recurring schedule has no usable address, skipping this occurrence', { scheduleId: s.id });
      await prisma.recurringSchedule.update({ where: { id: s.id }, data: { nextRunDate } });
      stats.skipped += 1;
      cursor = nextRunDate;
      continue;
    }

    if (template === null) {
      template =
        (await prisma.booking.findFirst({
          where: { recurringScheduleId: s.id },
          orderBy: { scheduledStart: 'desc' },
        })) || undefined;
    }

    const { data, end } = await buildOccurrence(s, address, template, start);

    const conflict = await prisma.booking.findFirst({
      where: {
        businessId: s.businessId,
        customerId: s.customerId,
        status: { notIn: ['CANCELLED'] },
        scheduledStart: { lt: end },
        scheduledEnd: { gt: start },
      },
    });
    if (conflict) {
      await prisma.recurringSchedule.update({ where: { id: s.id }, data: { nextRunDate } });
      logger.warn('Recurring occurrence conflicts with an existing booking, skipped', {
        scheduleId: s.id,
        conflictingBookingId: conflict.id,
        occurrenceStart: start.toISOString(),
      });
      try {
        await notifications.notifyRecurringConflict(s.businessId, s, conflict, start);
      } catch (notifyErr) {
        logger.warn('Failed to notify recurring conflict', { scheduleId: s.id, error: notifyErr.message });
      }
      stats.skipped += 1;
      cursor = nextRunDate;
      continue;
    }

    let booking = null;
    try {
      booking = await prisma.$transaction(async (tx) => {
        const b = await tx.booking.create({ data });
        await tx.recurringSchedule.update({ where: { id: s.id }, data: { nextRunDate } });
        return b;
      });
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      // (recurringScheduleId, scheduledStart) is unique: another replica got here first.
      await prisma.recurringSchedule.update({ where: { id: s.id }, data: { nextRunDate } });
      logger.info('Recurring booking already exists for this slot, advanced schedule', {
        scheduleId: s.id,
        start: start.toISOString(),
      });
      stats.skipped += 1;
      cursor = nextRunDate;
      continue;
    }

    try {
      await notifications.notifyBookingCreated(s.businessId, booking);
    } catch (notifyErr) {
      logger.warn('Failed to notify for recurring booking', { bookingId: booking.id, error: notifyErr.message });
    }
    logger.info('Created recurring booking', {
      scheduleId: s.id,
      bookingId: booking.id,
      nextRunDate: nextRunDate.toISOString(),
    });
    stats.created += 1;
    cursor = nextRunDate;
  }
}

async function processOnce() {
  const now = new Date();
  const horizon = new Date(now.getTime() + lookaheadMs());

  const schedules = await prisma.recurringSchedule.findMany({
    where: {
      status: 'ACTIVE',
      nextRunDate: { lte: horizon },
      business: { isActive: true },
    },
    include: {
      customer: { include: { addresses: true } },
      service: { include: { addOns: true } },
      customerAddress: true,
      business: true,
    },
    take: 100,
    orderBy: { nextRunDate: 'asc' },
  });

  const stats = { scanned: schedules.length, created: 0, skipped: 0, errors: 0 };

  for (const s of schedules) {
    try {
      await processSchedule(s, now, horizon, stats);
    } catch (e) {
      stats.errors += 1;
      logger.error('Failed to process recurring schedule', { scheduleId: s.id, error: e.message, stack: e.stack });
    }
  }

  logger.info('recurring processOnce finished', stats);
  return stats;
}

if (require.main === module) {
  processOnce()
    .then((stats) => {
      logger.info('recurring worker (single pass) done', stats);
      process.exit(stats.errors > 0 ? 1 : 0);
    })
    .catch((e) => {
      logger.error('recurring worker (single pass) failed', e);
      process.exit(1);
    });
}

module.exports = { processOnce, buildOccurrence };
