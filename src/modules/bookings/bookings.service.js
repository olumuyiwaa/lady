const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const notifications = require('../notifications/notifications.service');
const logger = require('../../config/logger');
const { createBookingCheckoutSession, createAncillaryCheckoutSession, createRefund, expireCheckoutSession } = require('../../lib/stripeClient');
const { assertOpen, statusAfterAssign } = require('../../lib/bookingStateMachine');
const { computeInitialRunDate } = require('../../utils/timezone');
const { evaluateCancellation } = require('../../lib/cancellationPolicy');
const { amountDueCents, jobPaymentCents } = require('../../lib/paymentMath');
const { assertCleanerFree } = require('../../lib/assignmentConflicts');
const payroll = require('../payroll/payroll.service');
const waitlist = require('../waitlist/waitlist.service');
const { pick } = require('../../utils/pick');
const transactions = require('../transactions/transactions.service');
const txRows = require('../transactions/transactions.builders');

// Fields staff may edit directly on an existing booking. Status, payment
// state, schedule and tenant are deliberately absent: they change through the
// dedicated confirm/complete/cancel/reschedule/payment endpoints, which apply
// the business rules (conflict checks, refunds, notifications, payroll).
const BOOKING_EDITABLE_FIELDS = [
  'addressLine1', 'addressLine2', 'city', 'state', 'latitude', 'longitude',
  'accessCode', 'keyLocation', 'parkingInstructions', 'petNotes', 'specialInstructions',
  'quotedPriceCents', 'autoChargeOnComplete',
];

async function listBookings(businessId, { status } = {}, requester = null) {
  const cleanerScope =
      requester?.businessRole === 'CLEANER'
          ? { assignments: { some: { cleanerId: requester.cleanerProfileId } } }
          : {};

  return prisma.booking.findMany({
    where: { businessId, ...(status ? { status } : {}), ...cleanerScope },
    include: { customer: true, service: true, assignments: { include: { cleaner: { include: { user: true } } } } },
    orderBy: { scheduledStart: 'desc' },
    take: 200,
  });
}

async function getBookingById(businessId, id, requester = null) {
  const b = await prisma.booking.findFirst({ where: { id, businessId }, include: { customer: true, service: true, assignments: true, business: { select: { stripeConnectedAccountId: true } } } });
  if (!b) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }

  if (requester?.businessRole === 'CLEANER') {
    const assigned = b.assignments.some((a) => a.cleanerId === requester.cleanerProfileId);
    if (!assigned) {
      // 404, not 403 — don't confirm to a cleaner that a booking they're not
      // on even exists.
      const err = new Error('Booking not found');
      err.status = 404;
      throw err;
    }
  }

  return b;
}

/**
 * Guards against the same customer ending up with two overlapping jobs on
 * the books — most commonly caused by an accidental double-submit on the
 * booking widget, or a one-off booking created for a slot a recurring
 * schedule already occupies. This only checks the *requesting customer's*
 * own bookings; cleaner-availability conflicts are handled separately by
 * findAvailableCleaners()/assignBooking() at dispatch time.
 */
async function assertNoCustomerConflict(businessId, customerId, start, end, excludeBookingId = null) {
  const overlapping = await prisma.booking.findFirst({
    where: {
      businessId,
      customerId,
      status: { notIn: ['CANCELLED'] },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      scheduledStart: { lt: end },
      scheduledEnd: { gt: start },
    },
  });
  if (overlapping) {
    const err = new Error('This customer already has another booking scheduled during that time window.');
    err.status = 409;
    err.code = 'BOOKING_TIME_CONFLICT';
    err.conflictingBookingId = overlapping.id;
    throw err;
  }
}

/** Travel-fee columns for a new booking, from a lib/pricing quote. */
function travelFeeFields(quote) {
  const cents = quote && quote.breakdown && quote.breakdown.travelFeeCents;
  if (!(cents > 0)) return {};
  return { travelFeeCents: cents, travelDistanceMeters: quote.breakdown.travelDistanceMeters ?? null };
}

async function createBooking(businessId, actorUserId, payload) {
  const {
    customerId, serviceId, addressLine1, addressLine2, city, state, latitude, longitude,
    scheduledStart, sqft, rooms, addOnIds, frequency, couponCode,
    accessCode, keyLocation, parkingInstructions, petNotes, specialInstructions,
  } = payload;
  const service = await prisma.service.findFirst({ where: { id: serviceId, businessId }, include: { addOns: true } });
  if (!service) {
    const err = new Error('Service not found');
    err.status = 404;
    throw err;
  }
  const customerRecord = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customerRecord) {
    const err = new Error('Customer not found for this business');
    err.status = 404;
    throw err;
  }
  const pricing = require('../../lib/pricing');
  const quote = await pricing.calculateQuote(service, { businessId, sqft, rooms, addOnIds, frequency, customDurationMinutes: service.estimatedMinutes, couponCode, latitude, longitude });

  const start = new Date(scheduledStart);
  const end = new Date(start.getTime() + (quote.breakdown.estimatedMinutes || service.estimatedMinutes) * 60 * 1000);

  await assertNoCustomerConflict(businessId, customerId, start, end);

  // If couponCode provided, validate and enforce redemption limits within a transaction
  if (couponCode) {
    const coupon = await prisma.coupon.findFirst({ where: { businessId, code: couponCode, isActive: true } });
    if (!coupon) {
      const err = new Error('Coupon not found'); err.status = 422; throw err;
    }
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
      const err = new Error('Coupon expired'); err.status = 422; throw err;
    }
    if (coupon.appliesToServiceId && coupon.appliesToServiceId !== serviceId) {
      const err = new Error('Coupon not applicable to this service'); err.status = 422; throw err;
    }

    const booking = await prisma.$transaction(async (tx) => {
      // per-customer limit
      if (coupon.perCustomerLimit) {
        const used = await tx.booking.count({ where: { customerId, couponId: coupon.id } });
        if (used >= coupon.perCustomerLimit) {
          const err = new Error('Coupon per-customer redemption limit reached'); err.status = 422; throw err;
        }
      }

      const b = await tx.booking.create({ data: { businessId, customerId, serviceId, addressLine1, addressLine2, city, state, latitude, longitude, accessCode, keyLocation, parkingInstructions, petNotes, specialInstructions, scheduledStart: start, scheduledEnd: end, quotedPriceCents: quote.priceCents, ...travelFeeFields(quote), status: 'REQUESTED', couponId: coupon.id } });

      // attempt to increment redeemedCount with maxRedemptions enforcement
      if (coupon.maxRedemptions) {
        const updated = await tx.coupon.updateMany({ where: { id: coupon.id, redeemedCount: { lt: coupon.maxRedemptions } }, data: { redeemedCount: { increment: 1 } } });
        if (updated.count === 0) {
          const err = new Error('Coupon redemption limit reached'); err.status = 409; throw err;
        }
      } else {
        await tx.coupon.update({ where: { id: coupon.id }, data: { redeemedCount: { increment: 1 } } });
      }

      return b;
    });

    await audit({ businessId, actorUserId, action: 'BOOKING_CREATED', entityType: 'Booking', entityId: booking.id });
    await notifications.notifyBookingCreated(businessId, booking);
    try { const customer = await prisma.customer.findUnique({ where: { id: customerId } }); if (customer) await notifications.sendCustomerBookingConfirmation(businessId, booking, customer); } catch (e) {}
    return booking;
  }

  const booking = await prisma.booking.create({ data: { businessId, customerId, serviceId, addressLine1, addressLine2, city, state, latitude, longitude, accessCode, keyLocation, parkingInstructions, petNotes, specialInstructions, scheduledStart: start, scheduledEnd: end, quotedPriceCents: quote.priceCents, ...travelFeeFields(quote), status: 'REQUESTED' } });

  await audit({ businessId, actorUserId, action: 'BOOKING_CREATED', entityType: 'Booking', entityId: booking.id });
  await notifications.notifyBookingCreated(businessId, booking);
  // send confirmation to customer when contact exists
  try {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (customer) await notifications.sendCustomerBookingConfirmation(businessId, booking, customer);
  } catch (e) {
    // ignore customer notification failures
  }
  return booking;
}

async function updateBooking(businessId, id, patch) {
  const booking = await getBookingById(businessId, id);
  const data = pick(patch, BOOKING_EDITABLE_FIELDS);
  if ('quotedPriceCents' in data) {
    if (!Number.isInteger(data.quotedPriceCents) || data.quotedPriceCents < 0) {
      const err = new Error('quotedPriceCents must be a non-negative integer');
      err.status = 422;
      throw err;
    }
    if (booking.paymentStatus === 'PAID' || booking.depositPaidAt) {
      const err = new Error('The price cannot be changed after a payment has been received');
      err.status = 409;
      throw err;
    }
  }
  if (Object.keys(data).length === 0) {
    const err = new Error('No editable fields supplied');
    err.status = 422;
    throw err;
  }
  const updated = await prisma.booking.update({ where: { id }, data });
  await audit({ businessId, action: 'BOOKING_UPDATED', entityType: 'Booking', entityId: id, metadata: data });
  return updated;
}

async function assignBooking(businessId, bookingId, cleanerId, actorUserId, options = {}) {
  const { isTeamLead = false, earningsSplitPercent } = options;
  if (earningsSplitPercent != null && (earningsSplitPercent < 0 || earningsSplitPercent > 100)) {
    const err = new Error('earningsSplitPercent must be between 0 and 100');
    err.status = 422;
    throw err;
  }

  const booking = await getBookingById(businessId, bookingId);
  assertOpen(booking, 'assign a cleaner to');
  const cleaner = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId, status: 'ACTIVE' } });
  if (!cleaner) {
    const err = new Error('Cleaner not available');
    err.status = 400;
    throw err;
  }

  // Same rule as dispatch: touching bookings are fine, cancelled ones never block.
  await assertCleanerFree(cleanerId, booking.scheduledStart, booking.scheduledEnd, { excludeBookingId: bookingId });

  const assignment = await prisma.bookingAssignment.create({
    data: { bookingId, cleanerId, isTeamLead, earningsSplitPercent },
  });
  const nextStatus = statusAfterAssign(booking.status);
  if (nextStatus !== booking.status) await prisma.booking.update({ where: { id: bookingId }, data: { status: nextStatus } });
  await audit({ businessId, actorUserId, action: 'BOOKING_ASSIGNED', entityType: 'BookingAssignment', entityId: assignment.id, metadata: { cleanerId } });
  // notify assigned cleaner via notifications
  const assignedCleaner = await prisma.cleanerProfile.findUnique({ where: { id: cleanerId }, include: { user: true } });
  if (assignedCleaner) {
    await notifications.notifyCleanerAssigned(businessId, booking, assignedCleaner.userId);
  }
  return assignment;
}

async function confirmBooking(businessId, bookingId, actorUserId) {
  const booking = await getBookingById(businessId, bookingId);
  if (booking.status === 'CANCELLED') {
    const err = new Error('Cannot confirm a cancelled booking');
    err.status = 409;
    throw err;
  }
  // Only a REQUESTED booking is confirmed. Already confirmed / assigned / in
  // progress / completed is a no-op: confirming must never move a booking backwards.
  if (booking.status !== 'REQUESTED') return booking;

  const updated = await prisma.booking.update({ where: { id: bookingId }, data: { status: 'CONFIRMED' } });
  await audit({ businessId, actorUserId, action: 'BOOKING_CONFIRMED', entityType: 'Booking', entityId: bookingId });
  try {
    await notifications.notifyBookingConfirmed(businessId, { ...updated, customer: booking.customer });
  } catch (e) {
    logger.warn('Failed to send booking confirmation', { bookingId, error: e.message });
  }
  return updated;
}

async function markPaymentReceived(
    businessId,
    bookingId,
    actorUserId,
    { method = 'BANK_TRANSFER', reference = null, amountCents = null, note = null } = {}
) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId },
  });
  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  if (booking.paymentStatus === 'PAID') {
    return booking; // idempotent
  }

  const allowed = ['CASH', 'BANK_TRANSFER', 'INVOICE', 'OTHER'];
  const payMethod = allowed.includes(method) ? method : 'OTHER';

  // What is still owed after any deposit, gift card and earlier part-payment.
  const due = amountDueCents(booking);
  const received =
      amountCents != null && Number.isInteger(amountCents) && amountCents > 0
          ? amountCents
          : due;
  if (received <= 0) {
    const err = new Error('There is nothing left to collect on this booking');
    err.status = 409;
    throw err;
  }
  // Recorded, not just audited: cancellations/refunds and reports read
  // amountPaidCents. Previously the amount only went into the audit log and
  // any amount at all flipped the booking to PAID.
  const fullyPaid = received >= due;
  const paidAmount = received;

  const paymentNoteParts = [
    `manual:${payMethod}`,
    `amount:${received}`,
    reference ? `ref:${String(reference).slice(0, 120)}` : null,
    note ? `note:${String(note).slice(0, 200)}` : null,
    `by:${actorUserId}`,
    `at:${new Date().toISOString()}`,
  ].filter(Boolean);

  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      paymentStatus: fullyPaid ? 'PAID' : 'PARTIAL',
      amountPaidCents: jobPaymentCents(booking) + received,
      paymentNote: [booking.paymentNote, paymentNoteParts.join(';')]
          .filter(Boolean)
          .join(' | '),
    },
  });

  await audit({
    businessId,
    actorUserId,
    action: 'BOOKING_PAYMENT_MARKED_RECEIVED',
    entityType: 'Booking',
    entityId: bookingId,
    metadata: { method: payMethod, reference, amountCents: paidAmount },
  });

  await transactions.record(txRows.jobPaymentManual({
    booking, method: payMethod, amountCents: paidAmount, reference, note,
  }));

  return updated;
}

async function completeBooking(businessId, bookingId, actorUserId, options = {}) {
  // paymentRequest: send a pay link even when the booking is not flagged autoChargeOnComplete
  // (the dashboard's "complete" button does; the cleaner app follows the flag).
  const { requestReview = true, force = false, paymentRequest = false } = options;

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId },
    include: {
      customer: true,
      service: true,
      business: true,
      checklist: true,
      assignments: true,
    },
  });

  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }

  if (booking.status === 'CANCELLED') {
    const err = new Error('Cannot complete a cancelled booking');
    err.status = 422;
    throw err;
  }

  if (booking.status === 'COMPLETED' && !force) {
    // Idempotent — already done
    return booking;
  }

  // Mark checklist completed if present and not already
  if (booking.checklist && !booking.checklist.completedAt) {
    await prisma.jobChecklist.update({
      where: { id: booking.checklist.id },
      data: { completedAt: new Date() },
    });
  }

  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: 'COMPLETED' },
  });

  await audit({
    businessId,
    actorUserId,
    action: 'BOOKING_COMPLETED',
    entityType: 'Booking',
    entityId: bookingId,
  });

  // Payment request: a Checkout link for whatever is still owed. One
  // implementation for both completion paths (createPaymentLink also stores the
  // session on the booking). Full off-session capture needs a saved payment
  // method / SEPA mandate - not built yet.
  if (
    (booking.autoChargeOnComplete || paymentRequest) &&
    booking.paymentStatus !== 'PAID' &&
    booking.business?.stripeChargesEnabled &&
    booking.business?.stripeConnectedAccountId &&
    amountDueCents(booking) > 0
  ) {
    try {
      const { url } = await createPaymentLink(businessId, bookingId, actorUserId);
      await notifications.sendCustomerPaymentLink(businessId, booking, booking.customer, url);
    } catch (chargeErr) {
      logger.error('Payment request on completion failed', { bookingId, error: chargeErr.message });
      // Non-fatal - the job is still completed
    }
  }

  // Ask for review
  if (requestReview && booking.customer) {
    try {
      await notifications.requestReview(businessId, booking, booking.customer);
    } catch (e) {
      logger.warn('Failed to request review', { bookingId, error: e.message });
    }
  }

  // Credit assigned cleaner(s) their earnings for this job, per whatever
  // compensation rule the business has set for each of them (if any).
  // Never fails the completion — a payroll snag shouldn't block the job
  // from being marked done.
  //
  // Anyone who clocked in but never out is finished now that the job is done.
  // HOURLY earnings need a check-out, so without this a dispatcher completing
  // the job (or a team lead completing for the team) silently paid nobody.
  try {
    await prisma.bookingAssignment.updateMany({
      where: { bookingId, checkedInAt: { not: null }, checkedOutAt: null },
      data: { checkedOutAt: new Date() },
    });
  } catch (e) {
    logger.warn('Failed to stamp check-outs', { bookingId, error: e.message });
  }
  try {
    await payroll.computeEarningsForBooking(businessId, bookingId);
  } catch (e) {
    logger.error('Failed to compute cleaner earnings', { bookingId, error: e.message });
  }

  // A referred customer's first visit is done: the referrer earns their reward
  // (after the business's hold period, if any). Never blocks completion.
  try {
    await require('../referrals/referralRewards').issueRewardForBooking(businessId, bookingId);
  } catch (e) {
    logger.error('Failed to issue referral reward', { bookingId, error: e.message });
  }

  return updated;
}

/**
 * Cleaner-facing complete path (used by the Flutter app).
 * Also records check-out location when provided.
 */
async function completeBookingByCleaner(bookingId, cleanerUserId, { lat, lng, notes } = {}) {
  // Resolve the profile THROUGH the assignment. Looking up "the first active
  // profile of this user" broke cleaners who work for two businesses: the
  // booking belonged to the second one and they got "not assigned".
  const assignment = await prisma.bookingAssignment.findFirst({
    where: { bookingId, cleaner: { userId: cleanerUserId, status: 'ACTIVE' } },
    include: { booking: true, cleaner: { include: { business: true } } },
  });
  if (!assignment) {
    const err = new Error('You are not assigned to this booking');
    err.status = 403;
    throw err;
  }
  const cleaner = assignment.cleaner;

  // Photo proof: require at least one AFTER photo before a job can be
  // marked complete. Without this, "photo proof" would just be an optional
  // upload button nobody uses under time pressure on-site.
  const afterPhotoCount = await prisma.jobPhoto.count({ where: { bookingId, stage: 'AFTER' } });
  if (afterPhotoCount === 0) {
    const err = new Error('Add at least one after-photo before marking this job complete.');
    err.status = 400;
    err.code = 'PHOTO_PROOF_REQUIRED';
    throw err;
  }

  // Record check-out
  await prisma.bookingAssignment.update({
    where: { id: assignment.id },
    data: {
      checkedOutAt: new Date(),
      // reuse checkIn fields if you prefer separate checkOutLat/Lng later
    },
  });

  // Update cleaner's last known location for better dispatch ranking
  if (lat != null && lng != null) {
    await prisma.cleanerProfile.update({
      where: { id: cleaner.id },
      data: {
        lastKnownLat: lat,
        lastKnownLng: lng,
        lastKnownAt: new Date(),
      },
    });
  }

  // `notes` was accepted by the route and dropped. Keep it with the job.
  if (notes && String(notes).trim()) {
    await audit({
      businessId: cleaner.businessId,
      actorUserId: cleanerUserId,
      action: 'BOOKING_CLEANER_NOTE',
      entityType: 'Booking',
      entityId: bookingId,
      metadata: { note: String(notes).trim().slice(0, 2000) },
    });
  }

  // Team jobs: the job is done when the team lead finishes, or when the last
  // cleaner who is still on site does. A helper checking out first only records
  // their own check-out (previously the first cleaner to tap "complete"
  // completed the job for everyone and the others' hourly pay was skipped).
  const stillOnSite = await prisma.bookingAssignment.count({
    where: { bookingId, checkedInAt: { not: null }, checkedOutAt: null },
  });
  if (!assignment.isTeamLead && stillOnSite > 0) {
    const current = await prisma.booking.findUnique({ where: { id: bookingId } });
    return { ...current, awaitingTeam: true };
  }

  return completeBooking(cleaner.businessId, bookingId, cleanerUserId, {
    requestReview: true,
  });
}

async function createRecurringSchedule(businessId, actorUserId, payload) {
  const { customerId, serviceId, customerAddressId, frequency, dayOfWeek, startTime } = payload;

  const customer = await prisma.customer.findFirst({ where: { id: customerId, businessId } });
  if (!customer) {
    const err = new Error('Customer not found for this business');
    err.status = 404;
    throw err;
  }
  const service = await prisma.service.findFirst({ where: { id: serviceId, businessId } });
  if (!service) {
    const err = new Error('Service not found for this business');
    err.status = 404;
    throw err;
  }
  if (customerAddressId) {
    const address = await prisma.customerAddress.findFirst({ where: { id: customerAddressId, customerId } });
    if (!address) {
      const err = new Error('Address does not belong to this customer');
      err.status = 422;
      throw err;
    }
  }

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  const nextRunDate = computeInitialRunDate(dayOfWeek, startTime, business.timezone);

  // Conflict check: does this customer already have an active/paused recurring
  // schedule for the same day-of-week + start time (optionally same address)?
  // Two schedules landing on the same slot every cycle is almost always a
  // mistake (double-entry, or a rebook that should have edited the existing
  // one instead), so we block it up front rather than letting the daemon
  // silently generate two overlapping bookings down the line.
  const conflicting = await prisma.recurringSchedule.findFirst({
    where: {
      businessId,
      customerId,
      dayOfWeek,
      startTime,
      status: { in: ['ACTIVE', 'PAUSED'] },
      ...(customerAddressId ? { customerAddressId } : {}),
    },
  });
  if (conflicting) {
    const err = new Error(
      'This customer already has a recurring schedule at that day and time. Edit or cancel the existing one instead of creating a duplicate.'
    );
    err.status = 409;
    err.code = 'RECURRING_SCHEDULE_CONFLICT';
    err.conflictingScheduleId = conflicting.id;
    throw err;
  }

  const created = await prisma.recurringSchedule.create({
    data: { businessId, customerId, serviceId, customerAddressId, frequency, dayOfWeek, startTime, nextRunDate },
  });
  await audit({ businessId, actorUserId, action: 'RECURRING_CREATED', entityType: 'RecurringSchedule', entityId: created.id });
  return created;
}

async function listRecurringSchedules(businessId) {
  return prisma.recurringSchedule.findMany({
    where: { businessId },
    include: { customer: true, service: true },
    orderBy: { createdAt: 'desc' },
  });
}

async function cancelRecurringSchedule(businessId, id, actorUserId) {
  const rs = await prisma.recurringSchedule.findFirst({ where: { id, businessId } });
  if (!rs) {
    const err = new Error('Recurring schedule not found');
    err.status = 404;
    throw err;
  }
  await prisma.recurringSchedule.update({ where: { id }, data: { status: 'CANCELLED' } });
  await audit({ businessId, actorUserId, action: 'RECURRING_CANCELLED', entityType: 'RecurringSchedule', entityId: id });
}

async function pauseRecurringSchedule(businessId, id, actorUserId) {
  const rs = await prisma.recurringSchedule.findFirst({ where: { id, businessId } });
  if (!rs) {
    const err = new Error('Recurring schedule not found');
    err.status = 404;
    throw err;
  }
  if (rs.status === 'CANCELLED') {
    const err = new Error('This schedule was cancelled and cannot be paused. Create a new schedule instead.');
    err.status = 409;
    throw err;
  }
  await prisma.recurringSchedule.update({ where: { id }, data: { status: 'PAUSED' } });
  await audit({ businessId, actorUserId, action: 'RECURRING_PAUSED', entityType: 'RecurringSchedule', entityId: id });
  return { id, status: 'PAUSED' };
}

async function resumeRecurringSchedule(businessId, id, actorUserId) {
  const rs = await prisma.recurringSchedule.findFirst({ where: { id, businessId } });
  if (!rs) {
    const err = new Error('Recurring schedule not found');
    err.status = 404;
    throw err;
  }
  // This is the fix for the original bug: a cancelled schedule must never be
  // resumable, only a paused one. Previously both states shared the same
  // isActive=false flag, so this check was impossible to make.
  if (rs.status === 'CANCELLED') {
    const err = new Error('This schedule was cancelled and cannot be resumed. Create a new schedule instead.');
    err.status = 409;
    throw err;
  }
  // Re-run the same conflict check as creation, since another schedule may
  // have been created in this slot while this one was paused.
  const conflicting = await prisma.recurringSchedule.findFirst({
    where: {
      id: { not: id },
      businessId,
      customerId: rs.customerId,
      dayOfWeek: rs.dayOfWeek,
      startTime: rs.startTime,
      status: { in: ['ACTIVE', 'PAUSED'] },
      ...(rs.customerAddressId ? { customerAddressId: rs.customerAddressId } : {}),
    },
  });
  if (conflicting) {
    const err = new Error('Cannot resume: another recurring schedule now occupies this day and time for this customer.');
    err.status = 409;
    err.code = 'RECURRING_SCHEDULE_CONFLICT';
    throw err;
  }
  await prisma.recurringSchedule.update({ where: { id }, data: { status: 'ACTIVE' } });
  await audit({ businessId, actorUserId, action: 'RECURRING_RESUMED', entityType: 'RecurringSchedule', entityId: id });
  return { id, status: 'ACTIVE' };
}

async function cancelBooking(businessId, bookingId, actorUserId, reason, options = {}) {
  const { waiveFee = false } = options;
  const booking = await getBookingById(businessId, bookingId);
  if (booking.status === 'COMPLETED' || booking.status === 'CANCELLED') {
    const err = new Error(`Cannot cancel a booking that is already ${booking.status}`);
    err.status = 422;
    throw err;
  }

  // waiveFee lets staff override the policy (e.g. business-caused
  // cancellation) without touching BusinessPricing itself.
  // Waiving the fee means the customer keeps everything they paid — it does
  // not mean nothing is refunded (the previous code returned a zero refund
  // whenever the fee was waived, so a deposit was silently kept).
  const evaluation = await evaluateCancellation(businessId, booking, { waiveFee });

  // Refund each Stripe payment separately: a deposit and a job payment are
  // different PaymentIntents, and one intent cannot be refunded for more than
  // it captured. A failure on one does not stop the others.
  const refunds = [];
  let refundedCents = 0;
  let failedCents = 0;
  for (const item of evaluation.refundPlan || []) {
    try {
      const r = await createRefund({
        paymentIntentId: item.paymentIntentId,
        amountCents: item.amountCents,
        reason: 'requested_by_customer',
        // Direct charges live on the business's account, so the refund does too.
        connectedAccountId: booking.business && booking.business.stripeConnectedAccountId,
        // A retried cancellation must not refund the same charge twice.
        idempotencyKey: `cancel-refund:${bookingId}:${item.paymentIntentId}:${item.amountCents}`,
      });
      if (r) {
        refunds.push(r);
        refundedCents += item.amountCents;
        if (r.id) {
          await transactions.record(txRows.refund({
            booking,
            refundId: r.id,
            paymentIntentId: item.paymentIntentId,
            amountCents: item.amountCents,
            reason: 'cancellation',
            cancellationFeeCents: evaluation.feeCents,
          }));
        }
      }
    } catch (e) {
      failedCents += item.amountCents;
      logger.error('cancellation refund failed', { bookingId, error: e.message });
      // The booking still gets cancelled; the amounts are recorded below so a
      // human can reconcile rather than the cancellation succeeding with no
      // trace of money owed.
    }
  }
  const manualRefundCents = evaluation.manualRefundCents || 0;
  const owedNote = [
    failedCents > 0 ? `refund_failed:${failedCents}` : null,
    manualRefundCents > 0 ? `refund_due_manual:${manualRefundCents}` : null,
  ].filter(Boolean);

  // REFUNDED only when everything paid came back and no fee was kept.
  const refundedAll = failedCents === 0 && manualRefundCents === 0 && evaluation.refundCents >= evaluation.alreadyPaidCents;

  const updated = await prisma.$transaction(async (tx) => {
    const b = await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: 'CANCELLED',
        cancelReason: reason || null,
        cancellationFeeCents: evaluation.feeCents || null,
        ...(refunds.length
          ? {
              refundedAmountCents: refundedCents,
              refundedAt: new Date(),
              stripeRefundId: refunds.map((r) => r.id).join(','),
              paymentStatus: refundedAll ? 'REFUNDED' : 'PARTIAL',
            }
          : {}),
        ...(owedNote.length
          ? { paymentNote: [booking.paymentNote, `cancel:${owedNote.join(';')}`].filter(Boolean).join(' | ') }
          : {}),
      },
    });

    // A cancelled booking must give back what it consumed. Gift card value
    // and coupon redemptions were taken when the booking was created and were
    // never returned, so cancelling burned the customer's gift card.
    if (booking.giftCardId && booking.giftCardAppliedCents > 0) {
      const card = await tx.giftCard.findUnique({ where: { id: booking.giftCardId } });
      if (card) {
        const restored = Math.min(card.initialValueCents, card.balanceCents + booking.giftCardAppliedCents);
        await tx.giftCard.update({ where: { id: card.id }, data: { balanceCents: restored } });
      }
    }
    if (booking.couponId) {
      await tx.coupon.updateMany({
        where: { id: booking.couponId, redeemedCount: { gt: 0 } },
        data: { redeemedCount: { decrement: 1 } },
      });
    }
    return b;
  });

  // Expire any unpaid payment links so a cancelled booking cannot be paid
  // afterwards (the webhook would otherwise mark it PAID). Best effort.
  const connectedAccountId = booking.business && booking.business.stripeConnectedAccountId;
  if (connectedAccountId) {
    if (booking.stripeCheckoutSessionId && booking.paymentStatus !== 'PAID') {
      await expireCheckoutSession(booking.stripeCheckoutSessionId, connectedAccountId);
    }
    if (booking.stripeDepositSessionId && !booking.depositPaidAt) {
      await expireCheckoutSession(booking.stripeDepositSessionId, connectedAccountId);
    }
  }

  await audit({
    businessId,
    actorUserId,
    action: 'BOOKING_CANCELLED',
    entityType: 'Booking',
    entityId: bookingId,
    metadata: { reason, feeCents: evaluation.feeCents, refundCents: refundedCents, refundFailedCents: failedCents, manualRefundDueCents: manualRefundCents },
  });
  try {
    await notifications.notifyBookingCancelled(businessId, updated);
  } catch (e) { /* non-fatal */ }
  try {
    // Someone else's cancellation is exactly the kind of freed slot a
    // waitlisted customer is hoping for — check before this capacity goes
    // unfilled. Never lets a notification failure affect the cancellation
    // that already succeeded above.
    await waitlist.notifyWaitlistForFreedSlot(businessId, {
      serviceId: updated.serviceId,
      scheduledStart: updated.scheduledStart,
      scheduledEnd: updated.scheduledEnd,
    });
  } catch (e) { /* non-fatal */ }
  return updated;
}

async function rescheduleBooking(businessId, bookingId, actorUserId, { scheduledStart, scheduledEnd }) {
  const booking = await getBookingById(businessId, bookingId);
  if (booking.status === 'COMPLETED' || booking.status === 'CANCELLED') {
    const err = new Error(`Cannot reschedule a booking that is ${booking.status}`);
    err.status = 422;
    throw err;
  }
  const start = new Date(scheduledStart);
  if (Number.isNaN(start.getTime())) {
    const err = new Error('Invalid scheduledStart');
    err.status = 422;
    throw err;
  }
  let end;
  if (scheduledEnd) {
    end = new Date(scheduledEnd);
  } else {
    const durationMs = new Date(booking.scheduledEnd).getTime() - new Date(booking.scheduledStart).getTime();
    end = new Date(start.getTime() + (durationMs > 0 ? durationMs : 60 * 60 * 1000));
  }

  // If assigned, check cleaner still free at new time
  const assignments = await prisma.bookingAssignment.findMany({ where: { bookingId } });
  for (const a of assignments) {
    const overlap = await prisma.bookingAssignment.findFirst({
      where: {
        cleanerId: a.cleanerId,
        bookingId: { not: bookingId },
        booking: { scheduledStart: { lte: end }, scheduledEnd: { gte: start }, status: { not: 'CANCELLED' } },
      },
    });
    if (overlap) {
      const err = new Error('Assigned cleaner is not available at the new time');
      err.status = 409;
      throw err;
    }
  }

  const updated = await prisma.booking.update({
    where: { id: bookingId },
    // reminderSentAt reset: a moved booking must get a reminder for its NEW time
    data: { scheduledStart: start, scheduledEnd: end, reminderSentAt: null },
  });
  await audit({ businessId, actorUserId, action: 'BOOKING_RESCHEDULED', entityType: 'Booking', entityId: bookingId, metadata: { scheduledStart: start, scheduledEnd: end } });
  try {
    await notifications.notifyBookingRescheduled(businessId, updated);
  } catch (e) { /* non-fatal */ }
  return updated;
}

async function updatePaymentStatus(businessId, bookingId, actorUserId, { paymentStatus, paymentNote }) {
  const existing = await getBookingById(businessId, bookingId);
  const allowed = ['UNPAID', 'PAID', 'PARTIAL', 'REFUNDED'];
  if (!allowed.includes(paymentStatus)) {
    const err = new Error(`paymentStatus must be one of ${allowed.join(', ')}`);
    err.status = 422;
    throw err;
  }
  const data = { paymentStatus, paymentNote: paymentNote || null };
  // Marking PAID by hand means the amount that was due has been received.
  // Leaving amountPaidCents empty made later refund/cancellation maths guess.
  if (paymentStatus === 'PAID' && existing.amountPaidCents == null) {
    data.amountPaidCents = amountDueCents(existing);
  }
  if (paymentStatus === 'UNPAID') data.amountPaidCents = null;
  // What this flip means for the money. Computed BEFORE the update, from the row as it was.
  const flipAmount = paymentStatus === 'PAID' && existing.paymentStatus !== 'PAID' ? amountDueCents(existing) : 0;
  const updated = await prisma.booking.update({ where: { id: bookingId }, data });
  if (flipAmount > 0) {
    // One row per booking, revived if the status is toggled back to PAID.
    await transactions.record(txRows.jobPaymentStatusFlip({ booking: existing, amountCents: flipAmount }), { updateOnConflict: true });
  } else if (paymentStatus === 'UNPAID') {
    // Setting UNPAID clears amountPaidCents, so payments recorded by hand no longer
    // stand. Card payments (Stripe) did happen and stay on the log.
    await transactions.reverseManualPayments(bookingId);
  }
  await audit({ businessId, actorUserId, action: 'BOOKING_PAYMENT_UPDATED', entityType: 'Booking', entityId: bookingId, metadata: { paymentStatus, paymentNote } });
  return updated;
}

// Override completeBooking to request review after completion
async function completeBookingWithReview(businessId, bookingId, actorUserId) {
  await getBookingById(businessId, bookingId); // 404 for another tenant's booking
  // Same implementation as the cleaner path (there used to be two diverging
  // copies); the dashboard button always sends the payment request.
  return completeBooking(businessId, bookingId, actorUserId, { requestReview: true, paymentRequest: true });
}

async function createPaymentLink(businessId, bookingId, actorUserId, { successUrl, cancelUrl } = {}) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, businessId },
    include: { customer: true, service: true },
  });
  if (!booking) {
    const err = new Error('Booking not found');
    err.status = 404;
    throw err;
  }
  if (booking.paymentStatus === 'PAID') {
    const err = new Error('Booking is already paid');
    err.status = 409;
    throw err;
  }
  if (!booking.quotedPriceCents || booking.quotedPriceCents <= 0) {
    const err = new Error('Booking has no quoted price');
    err.status = 422;
    throw err;
  }

  // Charge what is still owed, not the full quote: a deposit already paid, a
  // gift card and earlier part-payments all reduce it. Charging the full
  // quote made customers pay the deposit twice.
  const dueCents = amountDueCents(booking);
  if (dueCents <= 0) {
    await prisma.booking.update({ where: { id: bookingId }, data: { paymentStatus: 'PAID' } });
    const err = new Error('Nothing is left to pay on this booking');
    err.status = 409;
    throw err;
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { stripeConnectedAccountId: true, stripeChargesEnabled: true, currency: true },
  });
  if (!business?.stripeChargesEnabled || !business?.stripeConnectedAccountId) {
    const err = new Error(
        'This business has not finished setting up Stripe Connect, so it cannot accept card payments for bookings yet. Complete Stripe onboarding in Business Settings.'
    );
    err.status = 402;
    throw err;
  }

  const session = await createBookingCheckoutSession({
    bookingId: booking.id,
    businessId,
    connectedAccountId: business.stripeConnectedAccountId,
    amountCents: dueCents,
    // The business's own currency. A client-supplied `currency` used to be
    // honoured here, letting a caller bill in an unintended currency.
    currency: business.currency,
    customerEmail: booking.customer?.email || undefined,
    successUrl,
    cancelUrl,
    description: `${booking.service?.name || 'Cleaning'} — ${booking.customer?.firstName || ''} ${booking.customer?.lastName || ''}`.trim(),
  });

  await prisma.booking.update({
    where: { id: bookingId },
    data: {
      stripeCheckoutSessionId: session.id,
      paymentNote: `stripe_session:${session.id};created_at:${new Date().toISOString()}`,
    },
  });

  await audit({
    businessId,
    actorUserId,
    action: 'BOOKING_PAYMENT_LINK_CREATED',
    entityType: 'Booking',
    entityId: bookingId,
    metadata: { sessionId: session.id, url: session.url },
  });

  return { url: session.url, sessionId: session.id };
}

module.exports = {
  listBookings,
  getBookingById,
  createBooking,
  updateBooking,
  assignBooking,
  markPaymentReceived,
  confirmBooking,
  // Admin complete goes through review + optional payment path
  completeBooking: completeBookingWithReview,
  completeBookingByCleaner,
  createRecurringSchedule,
  listRecurringSchedules,
  cancelRecurringSchedule,
  pauseRecurringSchedule,
  resumeRecurringSchedule,
  cancelBooking,
  rescheduleBooking,
  updatePaymentStatus,
  createPaymentLink,
};