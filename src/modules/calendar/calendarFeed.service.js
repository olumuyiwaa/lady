const crypto = require('crypto');
const prisma = require('../../config/database');
const { renderFeed } = require('./ics');

const MANAGER_ROLES = ['BUSINESS_OWNER', 'BUSINESS_MANAGER'];
const MAX_ACTIVE_FEEDS_PER_USER = 10;
const WINDOW_PAST_DAYS = 14;
const WINDOW_FUTURE_DAYS = 120;
const MAX_EVENTS = 1000;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const isManager = (actor) => MANAGER_ROLES.includes(actor.businessRole);

/**
 * Create a feed. Owners/managers get a business-wide feed (or one for a chosen
 * cleaner); a cleaner can only ever get a feed of their OWN jobs, whatever
 * cleanerId they send. The secret is returned once and never stored.
 */
async function createFeed({ businessId, actor, cleanerId, label, baseUrl }) {
  let targetCleanerId = null;
  if (actor.businessRole === 'CLEANER') {
    if (!actor.cleanerProfileId) throw httpError(403, 'No cleaner profile');
    targetCleanerId = actor.cleanerProfileId;
  } else if (isManager(actor)) {
    if (cleanerId) {
      const cleaner = await prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } });
      if (!cleaner) throw httpError(404, 'Cleaner not found');
      targetCleanerId = cleaner.id;
    }
  } else {
    throw httpError(403, 'Not allowed');
  }

  const active = await prisma.calendarFeed.count({ where: { businessId, userId: actor.id, revokedAt: null } });
  if (active >= MAX_ACTIVE_FEEDS_PER_USER) {
    throw httpError(422, 'Too many calendar links. Revoke one you no longer use first.');
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const feed = await prisma.calendarFeed.create({
    data: {
      businessId,
      cleanerId: targetCleanerId,
      userId: actor.id,
      label: label ? String(label).slice(0, 80) : null,
      tokenHash: hashToken(token),
    },
  });

  const url = `${baseUrl.replace(/\/$/, '')}/api/v1/calendar-feed/${token}.ics`;
  return {
    id: feed.id,
    cleanerId: feed.cleanerId,
    label: feed.label,
    createdAt: feed.createdAt,
    url,
    // Many calendar apps open webcal:// directly as "subscribe".
    webcalUrl: url.replace(/^https?:\/\//, 'webcal://'),
  };
}

/** Never returns the secret: it is not recoverable, only revocable. */
async function listFeeds({ businessId, actor }) {
  const where = { businessId, revokedAt: null };
  if (!isManager(actor)) where.userId = actor.id;
  const feeds = await prisma.calendarFeed.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  return feeds.map((f) => ({
    id: f.id,
    cleanerId: f.cleanerId,
    label: f.label,
    createdAt: f.createdAt,
    lastAccessedAt: f.lastAccessedAt,
  }));
}

async function revokeFeed({ businessId, actor, id }) {
  const feed = await prisma.calendarFeed.findFirst({ where: { id, businessId, revokedAt: null } });
  // A cleaner may only revoke their own link; others look like "not found".
  if (!feed || (!isManager(actor) && feed.userId !== actor.id)) throw httpError(404, 'Calendar link not found');
  await prisma.calendarFeed.update({ where: { id }, data: { revokedAt: new Date() } });
}

/**
 * Resolve a token to its feed and make sure it is still allowed to read. Every
 * failure is the same 404, so a probe learns nothing about which part failed.
 */
async function resolveFeed(token) {
  if (!token || token.length < 32 || token.length > 128) throw httpError(404, 'Not found');
  const feed = await prisma.calendarFeed.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { business: { select: { name: true } }, cleaner: { include: { user: true } } },
  });
  if (!feed || feed.revokedAt) throw httpError(404, 'Not found');

  if (feed.cleanerId) {
    // Offboarded / suspended cleaners lose their calendar link automatically.
    if (!feed.cleaner || feed.cleaner.status !== 'ACTIVE') throw httpError(404, 'Not found');
  } else {
    const member = await prisma.businessMember.findFirst({
      where: { businessId: feed.businessId, userId: feed.userId, isActive: true, removedAt: null, role: { in: MANAGER_ROLES } },
    });
    if (!member) throw httpError(404, 'Not found');
  }
  return feed;
}

async function renderForToken(token, now = new Date()) {
  const feed = await resolveFeed(token);

  const where = {
    businessId: feed.businessId,
    scheduledStart: {
      gte: new Date(now.getTime() - WINDOW_PAST_DAYS * 86400000),
      lte: new Date(now.getTime() + WINDOW_FUTURE_DAYS * 86400000),
    },
  };
  if (feed.cleanerId) where.assignments = { some: { cleanerId: feed.cleanerId } };

  const bookings = await prisma.booking.findMany({
    where,
    include: {
      customer: true,
      service: true,
      assignments: { include: { cleaner: { include: { user: true } } } },
    },
    orderBy: { scheduledStart: 'asc' },
    take: MAX_EVENTS,
  });

  // "Last used" is a courtesy for the settings screen; touch it at most hourly
  // and never let it fail the feed.
  if (!feed.lastAccessedAt || now - new Date(feed.lastAccessedAt) > TOUCH_INTERVAL_MS) {
    prisma.calendarFeed.update({ where: { id: feed.id }, data: { lastAccessedAt: now } }).catch(() => {});
  }

  const owner = feed.cleaner?.user ? `${feed.cleaner.user.firstName || ''}`.trim() : '';
  const name = feed.cleanerId
    ? `${feed.business.name} · ${owner || 'My jobs'}`
    : `${feed.business.name} · Bookings`;
  return renderFeed({ name, bookings, forCleaner: !!feed.cleanerId, now });
}

module.exports = { createFeed, listFeeds, revokeFeed, renderForToken, resolveFeed, hashToken, MAX_ACTIVE_FEEDS_PER_USER };
