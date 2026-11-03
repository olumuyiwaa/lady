const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const { getSignedUploadUrl, getSignedDownloadUrl } = require('../../config/storage');
const cleanersService = require('../cleaners/cleaners.service');
const stripeClient = require('../../lib/stripeClient');
const { IMAGE_TYPES, DOCUMENT_TYPES, prefixes, assertKeyUnderPrefix, assertContentType } = require('../../lib/storageKeys');

// Document types a cleaner may submit about themselves. BACKGROUND_CHECK and
// CONTRACT are issued by the business, not the cleaner, so those stay
// admin-only via the existing /cleaner-documents endpoints.
const SELF_SERVICE_DOC_TYPES = ['ID_CARD', 'CERTIFICATION', 'INSURANCE', 'OTHER'];

async function getMyProfile(cleaner) {
  const full = await prisma.cleanerProfile.findUnique({
    where: { id: cleaner.id },
    include: {
      user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, avatarKey: true } },
      business: { select: { id: true, name: true, branding: { select: { logoKey: true, primaryColor: true, accentColor: true } } } },
      availability: true,
    },
  });
  let avatarUrl = null;
  if (full.user.avatarKey) {
    try {
      avatarUrl = await getSignedDownloadUrl(full.user.avatarKey);
    } catch (e) {
      avatarUrl = null;
    }
  }
  return { ...full, user: { ...full.user, avatarUrl } };
}

/**
 * A cleaner may update their own phone and avatar — not name or email.
 * Name/email changes go through the business (they're tied to onboarding
 * records and login identity) rather than being self-serve here.
 */
async function updateMyProfile(cleaner, { phone, avatarKey }) {
  const data = {};
  if (phone !== undefined) data.phone = phone;
  if (avatarKey !== undefined) {
    // null / '' clears the avatar; anything else must be a key this cleaner was
    // issued (getMyAvatarUploadUrl), not an arbitrary object in the bucket.
    data.avatarKey = avatarKey
      ? assertKeyUnderPrefix(avatarKey, prefixes.cleanerAvatar(cleaner.businessId, cleaner.id), 'avatarKey')
      : null;
  }

  if (Object.keys(data).length === 0) {
    return getMyProfile(cleaner);
  }

  await prisma.user.update({ where: { id: cleaner.userId }, data });

  await audit({
    businessId: cleaner.businessId,
    actorUserId: cleaner.userId,
    action: 'CLEANER_SELF_PROFILE_UPDATED',
    entityType: 'CleanerProfile',
    entityId: cleaner.id,
    metadata: { fields: Object.keys(data) },
  });

  return getMyProfile(cleaner);
}

async function getMyAvatarUploadUrl(cleaner, { contentType, filename } = {}) {
  const safeName = (filename || 'avatar').replace(/[^a-zA-Z0-9._-]/g, '_');
  const type = assertContentType(contentType || 'image/jpeg', IMAGE_TYPES);
  const key = `businesses/${cleaner.businessId}/cleaners/${cleaner.id}/avatar/${Date.now()}-${safeName}`;
  const uploadUrl = await getSignedUploadUrl(key, type);
  return { uploadUrl, avatarKey: key };
}

async function getMyAvailability(cleaner) {
  return prisma.cleanerAvailability.findMany({ where: { cleanerId: cleaner.id } });
}

async function updateMyAvailability(cleaner, slots) {
  // Delegates to the same service function the owner/manager admin route
  // uses, so a cleaner's self-set hours and a manager's override never drift
  // apart into two different code paths.
  const result = await cleanersService.setAvailability(cleaner.businessId, cleaner.id, slots);
  await audit({
    businessId: cleaner.businessId,
    actorUserId: cleaner.userId,
    action: 'CLEANER_SELF_AVAILABILITY_UPDATED',
    entityType: 'CleanerProfile',
    entityId: cleaner.id,
  });
  return result;
}

async function listMyDocuments(cleaner) {
  return prisma.cleanerDocument.findMany({
    where: { cleanerId: cleaner.id },
    orderBy: { createdAt: 'desc' },
  });
}

async function getMyDocumentUploadUrl(cleaner, { contentType, filename } = {}) {
  const safeName = (filename || 'doc').replace(/[^a-zA-Z0-9._-]/g, '_');
  const type = assertContentType(contentType, DOCUMENT_TYPES);
  const key = `businesses/${cleaner.businessId}/cleaners/${cleaner.id}/docs/${Date.now()}-${safeName}`;
  const uploadUrl = await getSignedUploadUrl(key, type);
  return { uploadUrl, storageKey: key };
}

async function createMyDocument(cleaner, body) {
  const type = SELF_SERVICE_DOC_TYPES.includes(body.type) ? body.type : 'OTHER';
  assertKeyUnderPrefix(body.storageKey, prefixes.cleanerDocs(cleaner.businessId, cleaner.id));

  const doc = await prisma.cleanerDocument.create({
    data: {
      businessId: cleaner.businessId,
      cleanerId: cleaner.id,
      type,
      title: body.title,
      storageKey: body.storageKey,
      mimeType: body.mimeType || null,
      fileSize: body.fileSize || null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      notes: body.notes || null,
      uploadedBy: cleaner.userId,
    },
  });

  await audit({
    businessId: cleaner.businessId,
    actorUserId: cleaner.userId,
    action: 'CLEANER_SELF_DOCUMENT_UPLOADED',
    entityType: 'CleanerDocument',
    entityId: doc.id,
    metadata: { type: doc.type, title: doc.title },
  });

  return doc;
}

async function getMyDocumentDownloadUrl(cleaner, id) {
  const doc = await prisma.cleanerDocument.findFirst({ where: { id, cleanerId: cleaner.id } });
  if (!doc) {
    const err = new Error('Document not found');
    err.status = 404;
    throw err;
  }
  const downloadUrl = await getSignedDownloadUrl(doc.storageKey);
  return { downloadUrl, document: doc };
}

/**
 * Starts (or resumes) Stripe Connect Express onboarding for this cleaner.
 * The account is created lazily on first call and cached on User — see the
 * schema comment on User.stripeConnectedAccountId for why this lives at the
 * user level rather than on the per-business CleanerProfile.
 */
async function getStripeOnboardingLink(cleaner, { refreshUrl, returnUrl } = {}) {
  const user = await prisma.user.findUnique({ where: { id: cleaner.userId } });
  const { url } = await stripeClient.createCleanerConnectAccountAndLink(user, { refreshUrl, returnUrl });
  return { url };
}

/**
 * Current Stripe Connect status for this cleaner, for the earnings screen
 * to show "connect your payout account" vs. "payouts enabled". Also
 * refreshes the cached User.stripePayoutsEnabled flag so payroll.service
 * can gate the business's "Pay via Stripe" action without a Stripe call on
 * every payout list.
 */
async function getStripeStatus(cleaner) {
  const user = await prisma.user.findUnique({ where: { id: cleaner.userId } });
  if (!user.stripeConnectedAccountId) {
    return { connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
  }
  const status = await stripeClient.getConnectAccountStatus(user.stripeConnectedAccountId);
  if (status.payoutsEnabled !== user.stripePayoutsEnabled) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        stripePayoutsEnabled: status.payoutsEnabled,
        ...(status.payoutsEnabled && !user.stripeConnectOnboardedAt ? { stripeConnectOnboardedAt: new Date() } : {}),
      },
    });
  }
  return { connected: true, ...status };
}

module.exports = {
  SELF_SERVICE_DOC_TYPES,
  getMyProfile,
  updateMyProfile,
  getMyAvatarUploadUrl,
  getMyAvailability,
  updateMyAvailability,
  listMyDocuments,
  getMyDocumentUploadUrl,
  createMyDocument,
  getMyDocumentDownloadUrl,
  registerDeviceToken,
  unregisterDeviceToken,
  getStripeOnboardingLink,
  getStripeStatus,
};

/**
 * Upserts the FCM registration token for this cleaner's device. Called on
 * every app start (not just first install) since a token can rotate, and
 * upserting is cheap/idempotent — matches how most push-notification setups
 * work rather than trying to detect "is this a new token".
 */
async function registerDeviceToken(cleaner, { token, platform }) {
  return prisma.cleanerDeviceToken.upsert({
    where: { cleanerId_token: { cleanerId: cleaner.id, token } },
    update: { lastSeenAt: new Date(), platform: platform || undefined },
    create: { cleanerId: cleaner.id, token, platform },
  });
}

/** Called on logout so a shared/reset device stops receiving this cleaner's pushes. */
async function unregisterDeviceToken(cleaner, token) {
  await prisma.cleanerDeviceToken.deleteMany({ where: { cleanerId: cleaner.id, token } });
}
