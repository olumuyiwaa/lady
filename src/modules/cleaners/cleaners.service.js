const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const notifications = require('../notifications/notifications.service');
const { getIo } = require('../../config/socket');
const logger = require('../../config/logger');
const { getEffectivePlan } = require('../../lib/subscriptionAccess');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Plan limit on ACTIVE cleaners. A business in its no-card trial gets the cheapest plan's limit. */
async function assertWithinCleanerLimit(businessId) {
  const plan = await getEffectivePlan(businessId);
  if (plan && typeof plan.maxCleaners === 'number') {
    const activeCount = await prisma.cleanerProfile.count({ where: { businessId, status: 'ACTIVE' } });
    if (activeCount >= plan.maxCleaners) throw httpError(402, 'Cleaner limit reached for current subscription plan');
  }
}

/**
 * Onboards a cleaner into a business. If no User exists for the given email,
 * one is created with an unusable random password hash — the account can
 * only be unlocked via the invite link (a real PasswordReset token) that
 * sendInvite emails/texts to them, which they use to set their own password.
 */
async function onboardCleaner(businessId, actorUserId, { firstName, lastName, email, phone, hireDate }) {
  // Check the plan limit before any side effect. It used to run after the user
  // row was created and the invite email/SMS sent, so hitting the limit still
  // created an account and mailed the person an invite.
  await assertWithinCleanerLimit(businessId);

  let user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    const unusablePassword = crypto.randomBytes(32).toString('hex');
    user = await prisma.user.create({
      data: {
        email,
        phone,
        firstName,
        lastName,
        passwordHash: await bcrypt.hash(unusablePassword, 12),
      },
    });
    // dispatch invite email/SMS with a real password-set link (notifications module)
    try {
      await notifications.sendInvite(businessId, user.id, { email, phone });
    } catch (e) {
      // non-fatal
    }
  }

  const existingProfile = await prisma.cleanerProfile.findUnique({
    where: { businessId_userId: { businessId, userId: user.id } },
  });
  if (existingProfile && existingProfile.status !== 'OFFBOARDED') {
    const err = new Error('This person already has a cleaner profile at this business');
    err.status = 409;
    throw err;
  }

  const profile = existingProfile
      ? await prisma.cleanerProfile.update({
        where: { id: existingProfile.id },
        data: {
          status: 'ACTIVE',
          hireDate: hireDate ? new Date(hireDate) : new Date(),
          offboardedAt: null,
          offboardedReason: null,
        },
      })
      : await prisma.cleanerProfile.create({
        data: {
          businessId,
          userId: user.id,
          status: 'ACTIVE',
          hireDate: hireDate ? new Date(hireDate) : new Date(),
        },
      });

  await audit({
    businessId,
    actorUserId,
    action: existingProfile ? 'CLEANER_REONBOARDED' : 'CLEANER_ONBOARDED',
    entityType: 'CleanerProfile',
    entityId: profile.id,
  });

  return profile;
}

/**
 * Offboards a cleaner. Does not delete the profile — keeps history for past
 * bookings/reviews intact, just marks the relationship ended.
 */
const OPEN_JOB_STATUSES = ['REQUESTED', 'CONFIRMED', 'ASSIGNED'];

/** Future jobs this cleaner is assigned to and has not started. */
async function listUpcomingJobs(businessId, cleanerId) {
  const profile = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!profile) throw httpError(404, 'Cleaner not found for this business');
  return prisma.bookingAssignment.findMany({
    where: {
      cleanerId,
      checkedInAt: null,
      booking: { businessId, status: { in: OPEN_JOB_STATUSES }, scheduledStart: { gte: new Date() } },
    },
    include: {
      booking: {
        select: { id: true, status: true, scheduledStart: true, scheduledEnd: true, addressLine1: true, city: true },
      },
    },
    orderBy: { booking: { scheduledStart: 'asc' } },
  });
}

/**
 * Takes a cleaner out of service (offboard or suspend) and cleans up what
 * that leaves behind. Offboarding used to flip a status and stop there:
 * upcoming jobs stayed assigned to someone who could no longer open the app
 * (so customers got no-shows), device tokens kept receiving pushes, and any
 * open realtime connection stayed alive. Now, in one transaction, the
 * cleaner's not-yet-started future jobs are unassigned (bookings left with no
 * cleaner go back to CONFIRMED), push tokens are removed, and their sessions
 * for this business are ended; managers are told which jobs need a new cleaner.
 */
async function releaseCleaner(businessId, actorUserId, cleanerId, { status, reason, action }) {
  const profile = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!profile) throw httpError(404, 'Cleaner not found for this business');
  if (profile.status === status) return { profile, unassignedBookingIds: [] };

  const now = new Date();
  const unassignedBookingIds = [];

  const updated = await prisma.$transaction(async (tx) => {
    const upcoming = await tx.bookingAssignment.findMany({
      where: {
        cleanerId,
        checkedInAt: null,
        booking: { businessId, status: { in: OPEN_JOB_STATUSES }, scheduledStart: { gte: now } },
      },
      include: { booking: { select: { id: true, status: true } } },
    });
    if (upcoming.length) {
      await tx.bookingAssignment.deleteMany({ where: { id: { in: upcoming.map((a) => a.id) } } });
      for (const a of upcoming) {
        const remaining = await tx.bookingAssignment.count({ where: { bookingId: a.bookingId } });
        if (remaining === 0 && a.booking.status === 'ASSIGNED') {
          await tx.booking.update({ where: { id: a.bookingId }, data: { status: 'CONFIRMED' } });
        }
        unassignedBookingIds.push(a.bookingId);
      }
    }

    const p = await tx.cleanerProfile.update({
      where: { id: cleanerId },
      data:
        status === 'OFFBOARDED'
          ? { status, offboardedAt: now, offboardedReason: reason || null }
          : { status },
    });
    await tx.cleanerDeviceToken.deleteMany({ where: { cleanerId } });
    await tx.session.deleteMany({ where: { userId: profile.userId, businessId } });
    return p;
  });

  // Close live connections; the socket handshake only checks the token once,
  // so an open socket would otherwise keep receiving business events.
  try {
    getIo().in(`user:${profile.userId}`).disconnectSockets(true);
  } catch (e) {
    logger.debug('socket disconnect skipped', { error: e.message });
  }

  await audit({
    businessId,
    actorUserId,
    action,
    entityType: 'CleanerProfile',
    entityId: cleanerId,
    metadata: { reason, unassignedBookingIds },
  });

  if (unassignedBookingIds.length && notifications.notifyMembers) {
    try {
      await notifications.notifyMembers(
        businessId,
        'JOBS_NEED_REASSIGNMENT',
        'Jobs need a new cleaner',
        `${unassignedBookingIds.length} upcoming job(s) were unassigned when a cleaner left. Assign them to someone else.`
      );
    } catch (e) {
      logger.error('failed to notify managers about unassigned jobs', { error: e.message });
    }
  }

  return { profile: updated, unassignedBookingIds };
}

async function offboardCleaner(businessId, actorUserId, cleanerId, reason) {
  const { profile, unassignedBookingIds } = await releaseCleaner(businessId, actorUserId, cleanerId, {
    status: 'OFFBOARDED',
    reason,
    action: 'CLEANER_OFFBOARDED',
  });
  return { ...profile, unassignedBookingIds };
}

async function suspendCleaner(businessId, actorUserId, cleanerId, reason) {
  const existing = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (existing && existing.status !== 'ACTIVE') throw httpError(409, `Only active cleaners can be suspended (this one is ${existing.status})`);
  const { profile, unassignedBookingIds } = await releaseCleaner(businessId, actorUserId, cleanerId, {
    status: 'SUSPENDED',
    reason,
    action: 'CLEANER_SUSPENDED',
  });
  return { ...profile, unassignedBookingIds };
}

async function reactivateCleaner(businessId, actorUserId, cleanerId) {
  const profile = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!profile) throw httpError(404, 'Cleaner not found for this business');
  if (profile.status !== 'SUSPENDED') throw httpError(409, 'Only suspended cleaners can be reactivated');
  await assertWithinCleanerLimit(businessId);
  const updated = await prisma.cleanerProfile.update({ where: { id: cleanerId }, data: { status: 'ACTIVE' } });
  await audit({ businessId, actorUserId, action: 'CLEANER_REACTIVATED', entityType: 'CleanerProfile', entityId: cleanerId });
  return updated;
}

async function listCleaners(businessId, { status } = {}) {
  return prisma.cleanerProfile.findMany({
    where: { businessId, ...(status ? { status } : {}) },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

async function setAvailability(businessId, cleanerId, slots) {
  const profile = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!profile) {
    const err = new Error('Cleaner not found for this business');
    err.status = 404;
    throw err;
  }

  await prisma.$transaction([
    prisma.cleanerAvailability.deleteMany({ where: { cleanerId } }),
    prisma.cleanerAvailability.createMany({
      data: slots.map((s) => ({ cleanerId, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime })),
    }),
  ]);

  return prisma.cleanerAvailability.findMany({ where: { cleanerId } });
}


/**
 * Quality + throughput snapshot for a single cleaner — average rating,
 * review count, low-rating count, jobs, and revenue. Delegates to the same
 * logic the business-wide cleaner-performance report uses so the numbers
 * never drift apart between the two views.
 */
async function getCleanerPerformance(businessId, cleanerId, { from, to } = {}) {
  const profile = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
  if (!profile) {
    const err = new Error('Cleaner not found for this business');
    err.status = 404;
    throw err;
  }
  const reportsService = require('../reports/reports.service');
  const all = await reportsService.cleanerPerformance(businessId, { from, to });
  return all.find((r) => r.cleanerId === cleanerId) || null;
}

async function clockIn(businessId, cleanerId, assignmentId, actorUserId, { lat, lng }) {
  const assignment = await prisma.bookingAssignment.findFirst({
    where: { id: assignmentId },
    include: { booking: true, cleaner: true },
  });
  if (!assignment || assignment.cleanerId !== cleanerId || assignment.booking.businessId !== businessId) {
    const err = new Error('Assignment not found or mismatch');
    err.status = 404;
    throw err;
  }

  // ensure actor is either the cleaner user or a business member
  const cleaner = await prisma.cleanerProfile.findUnique({
    where: { id: cleanerId },
    include: { user: true },
  });
  if (!cleaner) {
    const err = new Error('Cleaner profile not found');
    err.status = 404;
    throw err;
  }

  if (actorUserId !== cleaner.userId) {
    // allow business members with role to clock in on behalf
    const bm = await prisma.businessMember.findFirst({
      where: { businessId, userId: actorUserId, isActive: true },
    });
    if (!bm) {
      const err = new Error('Not authorized to clock in for this cleaner');
      err.status = 403;
      throw err;
    }
  }

  // Idempotent: already checked in
  if (assignment.checkedInAt) {
    return assignment;
  }
  if (['CANCELLED', 'COMPLETED'].includes(assignment.booking.status)) {
    const err = new Error(`This booking is already ${assignment.booking.status.toLowerCase()}`);
    err.status = 409;
    throw err;
  }

  // Geofence. A booking stored without coordinates used to switch the check off
  // entirely, so look the address up now and remember the result.
  let bookingLat = assignment.booking.latitude;
  let bookingLng = assignment.booking.longitude;
  if (bookingLat == null || bookingLng == null) {
    const found = await require('../../lib/geocode').geocodeNl({
      postalCode: assignment.booking.postalCode,
      addressLine1: assignment.booking.addressLine1,
      city: assignment.booking.city,
    });
    if (found) {
      bookingLat = found.latitude;
      bookingLng = found.longitude;
      try {
        await prisma.booking.update({
          where: { id: assignment.bookingId },
          data: { latitude: bookingLat, longitude: bookingLng },
        });
      } catch (e) {
        /* caching the coordinates is best-effort */
      }
    }
  }

  // Strict check: within 500 m whenever both sides have coordinates.
  if (bookingLat != null && bookingLng != null && lat != null && lng != null) {
    const { distanceMeters } = require('../../utils/geo');
    const d = distanceMeters(lat, lng, bookingLat, bookingLng);
    if (d > 500) {
      const err = new Error('Not within allowed check-in range of the booking');
      err.status = 422;
      throw err;
    }
  }

  // A check-in without a device location is allowed (GPS fails indoors, and a
  // manager may clock someone in), but it is not "verified": say so in the audit
  // trail so the business can review those instead of trusting them blindly.
  let verification = 'GEOFENCED';
  if (actorUserId !== cleaner.userId) verification = 'MANAGER';
  else if (lat == null || lng == null) verification = 'NO_DEVICE_LOCATION';
  else if (bookingLat == null || bookingLng == null) verification = 'NO_BOOKING_COORDINATES';

  const now = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const a = await tx.bookingAssignment.update({
      where: { id: assignmentId },
      data: {
        checkedInAt: now,
        checkInLat: lat ?? null,
        checkInLng: lng ?? null,
      },
    });

    // Move booking into IN_PROGRESS when cleaner clocks in
    if (['REQUESTED', 'CONFIRMED', 'ASSIGNED'].includes(assignment.booking.status)) {
      await tx.booking.update({
        where: { id: assignment.bookingId },
        data: { status: 'IN_PROGRESS' },
      });
    }

    // Best-known live position for dispatch ranking
    if (lat != null && lng != null) {
      await tx.cleanerProfile.update({
        where: { id: cleanerId },
        data: {
          lastKnownLat: lat,
          lastKnownLng: lng,
          lastKnownAt: now,
        },
      });
    }

    return a;
  });

  await audit({
    businessId,
    actorUserId,
    action: 'CLEANER_CHECKED_IN',
    entityType: 'BookingAssignment',
    entityId: assignmentId,
    metadata: { lat, lng, bookingId: assignment.bookingId, verification },
  });

  // (This used to call notifyCleanerAssigned here — telling the cleaner they
  // had just been assigned the job they were checking in to.)
  return updated;
}

async function clockOut(businessId, cleanerId, assignmentId, actorUserId, { lat, lng }) {
  const assignment = await prisma.bookingAssignment.findFirst({
    where: { id: assignmentId },
    include: { booking: true, cleaner: true },
  });
  if (!assignment || assignment.cleanerId !== cleanerId || assignment.booking.businessId !== businessId) {
    const err = new Error('Assignment not found or mismatch');
    err.status = 404;
    throw err;
  }

  const cleaner = await prisma.cleanerProfile.findUnique({
    where: { id: cleanerId },
    include: { user: true },
  });
  if (!cleaner) {
    const err = new Error('Cleaner profile not found');
    err.status = 404;
    throw err;
  }

  if (actorUserId !== cleaner.userId) {
    const bm = await prisma.businessMember.findFirst({
      where: { businessId, userId: actorUserId, isActive: true },
    });
    if (!bm) {
      const err = new Error('Not authorized to clock out for this cleaner');
      err.status = 403;
      throw err;
    }
  }

  const now = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const a = await tx.bookingAssignment.update({
      where: { id: assignmentId },
      data: { checkedOutAt: now },
    });

    if (lat != null && lng != null) {
      await tx.cleanerProfile.update({
        where: { id: cleanerId },
        data: {
          lastKnownLat: lat,
          lastKnownLng: lng,
          lastKnownAt: now,
        },
      });
    }

    return a;
  });

  await audit({
    businessId,
    actorUserId,
    action: 'CLEANER_CHECKED_OUT',
    entityType: 'BookingAssignment',
    entityId: assignmentId,
    metadata: { lat, lng, bookingId: assignment.bookingId },
  });

  return updated;
}

module.exports = {
  onboardCleaner,
  offboardCleaner,
  suspendCleaner,
  reactivateCleaner,
  listUpcomingJobs,
  listCleaners,
  setAvailability,
  getCleanerPerformance,
  clockIn,
  clockOut,
};