const prisma = require('../../config/database');
const { assertSubdomainAllowed } = require('../../lib/reservedSlugs');
const { getPublicUrl, getPublicUploadUrl } = require('../../config/storage');
const { toPublicBranding } = require('../../lib/branding');
const crypto = require('crypto');
const { pick } = require('../../utils/pick');
const { isValidTimeZone } = require('../../utils/timezone');
const { normalizeKvk, normalizeVatNumber, normalizeIban } = require('../../lib/taxIdentifiers');
const { isEmailAddress, isPhoneText } = require('../../lib/contactMail');
const { PUBLIC_IMAGE_TYPES, prefixes, assertKeyUnderPrefix, assertContentType } = require('../../lib/storageKeys');

const ADDRESS_FIELDS = ['label', 'line1', 'line2', 'city', 'state', 'postalCode', 'country', 'latitude', 'longitude', 'isPrimary'];
const SERVICE_AREA_FIELDS = ['name', 'centerLat', 'centerLng', 'radiusMeters'];

// ============================================================
// FRANCHISE / MULTI-LOCATION
// ============================================================
const { audit } = require('../../utils/audit');
const { revalidateStorefront } = require('../../lib/storefrontRevalidate');

async function listLocations(parentBusinessId) {
  return prisma.business.findMany({
    where: { parentBusinessId },
    select: { id: true, name: true, subdomain: true, timezone: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
}

async function createLocation(parentBusinessId, actorUserId, { name, subdomain, timezone }) {
  assertSubdomainAllowed(subdomain);
  if (timezone && !isValidTimeZone(timezone)) {
    const err = new Error('timezone must be a valid IANA time zone, e.g. Europe/Amsterdam');
    err.status = 422;
    throw err;
  }
  const parent = await prisma.business.findUnique({ where: { id: parentBusinessId } });
  if (!parent) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }
  if (parent.parentBusinessId) {
    const err = new Error('A location cannot itself have sub-locations');
    err.status = 422;
    throw err;
  }

  const subdomainTaken = await prisma.business.findUnique({ where: { subdomain } });
  if (subdomainTaken) {
    const err = new Error('That subdomain is already taken');
    err.status = 409;
    throw err;
  }

  const location = await prisma.business.create({
    data: {
      name,
      subdomain,
      timezone: timezone || parent.timezone,
      parentBusinessId,
      branding: { create: {} },
      hours: {
        create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          openTime: '08:00',
          closeTime: '18:00',
          isClosed: dayOfWeek === 0,
        })),
      },
    },
  });

  await audit({
    businessId: parentBusinessId,
    actorUserId,
    action: 'LOCATION_CREATED',
    entityType: 'Business',
    entityId: location.id,
    metadata: { name, subdomain },
  });

  return location;
}



async function listBusinesses(businessId) {
  // For the businesses route (tenant-scoped), return the current business
  return prisma.business.findUnique({
    where: { id: businessId },
    include: { branding: true, addresses: true, hours: true },
  });
}

// Fields a BUSINESS_OWNER/BUSINESS_MANAGER can actually change through this
// endpoint. Previously this spread req.body straight into prisma's update,
// which meant a business-settings request could also silently rewrite
// stripeConnectedAccountId, isActive, parentBusinessId, or anything else on
// the model. The dashboard's own updateBusiness() type already only ever
// sends these three fields — this just makes the backend enforce it too.
const PATCHABLE_BUSINESS_FIELDS = [
  'name',
  'timezone',
  'defaultLocale',
  'customDomain',
  'preferredPaymentCollection',
  'offlinePaymentInstructions',
  'currency',
  // Invoicing / BTW
  'legalName',
  'kvkNumber',
  'vatNumber',
  'invoiceIban',
  'vatRateBps',
  // Contact details (contactEmail is private - see schema.prisma)
  'contactEmail',
  'contactPhone',
];

const ALLOWED_PAYMENT_COLLECTION = ['ONLINE_CARD', 'MANUAL_OFFLINE', 'BOTH'];

async function updateBusiness(businessId, patch) {
  const b = await prisma.business.findUnique({ where: { id: businessId } });
  if (!b) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }

  const data = {};
  for (const key of PATCHABLE_BUSINESS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) data[key] = patch[key];
  }

  if ('currency' in data) {
    const code = String(data.currency || '').trim().toLowerCase();
    const supported = Intl.supportedValuesOf('currency').map((c) => c.toLowerCase());
    if (!supported.includes(code)) {
      const err = new Error('currency must be a valid ISO 4217 code (e.g. eur, usd, gbp)');
      err.status = 422;
      throw err;
    }
    // Changing currency once money has been taken would leave the same
    // business with payments in two currencies and payouts that no longer add up.
    if (code !== b.currency) {
      const taken = await prisma.booking.count({
        where: { businessId, OR: [{ paymentStatus: { in: ['PAID', 'PARTIAL', 'DEPOSIT_PAID'] } }, { depositPaidAt: { not: null } }] },
      });
      if (taken > 0) {
        const err = new Error('Currency cannot be changed after payments have been recorded');
        err.status = 409;
        throw err;
      }
    }
    data.currency = code;
  }

  if ('defaultLocale' in data && !['nl', 'en'].includes(data.defaultLocale)) {
    const err = new Error('defaultLocale must be "nl" or "en"');
    err.status = 422;
    throw err;
  }

  // An invalid zone would make slot generation throw for every public request of this business.
  if ('timezone' in data && !isValidTimeZone(data.timezone)) {
    const err = new Error('timezone must be a valid IANA time zone, e.g. Europe/Amsterdam');
    err.status = 422;
    throw err;
  }

  // Tax identity: blank clears the field, anything else must be valid.
  const invalid = (msg) => { const err = new Error(msg); err.status = 422; return err; };
  const cleared = (v) => v == null || String(v).trim() === '';
  if ('legalName' in data) {
    data.legalName = cleared(data.legalName) ? null : String(data.legalName).trim().slice(0, 200);
  }
  if ('kvkNumber' in data) {
    if (cleared(data.kvkNumber)) data.kvkNumber = null;
    else if (!(data.kvkNumber = normalizeKvk(data.kvkNumber))) throw invalid('kvkNumber must be an 8-digit KvK number');
  }
  if ('vatNumber' in data) {
    if (cleared(data.vatNumber)) data.vatNumber = null;
    else if (!(data.vatNumber = normalizeVatNumber(data.vatNumber))) throw invalid('vatNumber must be a valid BTW-id (e.g. NL123456789B01)');
  }
  if ('contactEmail' in data) {
    if (cleared(data.contactEmail)) data.contactEmail = null;
    else {
      data.contactEmail = String(data.contactEmail).trim().toLowerCase();
      if (!isEmailAddress(data.contactEmail)) throw invalid('contactEmail must be a valid email address');
    }
  }
  if ('contactPhone' in data) {
    if (cleared(data.contactPhone)) data.contactPhone = null;
    else {
      data.contactPhone = String(data.contactPhone).trim();
      if (!isPhoneText(data.contactPhone)) throw invalid('contactPhone must be a valid phone number');
    }
  }
  if ('invoiceIban' in data) {
    if (cleared(data.invoiceIban)) data.invoiceIban = null;
    else if (!(data.invoiceIban = normalizeIban(data.invoiceIban))) throw invalid('invoiceIban must be a valid IBAN');
  }
  if ('vatRateBps' in data) {
    const n = Number(data.vatRateBps);
    if (!Number.isInteger(n) || n < 0 || n > 3000) throw invalid('vatRateBps must be a whole number of basis points between 0 and 3000 (2100 = 21%)');
    data.vatRateBps = n;
  }

  if ('preferredPaymentCollection' in data) {
    if (!ALLOWED_PAYMENT_COLLECTION.includes(data.preferredPaymentCollection)) {
      const err = new Error(
          `preferredPaymentCollection must be one of ${ALLOWED_PAYMENT_COLLECTION.join(', ')}`
      );
      err.status = 422;
      throw err;
    }
    // ONLINE_CARD is the one setting getStorefront() does NOT fall back to
    // offline for (see its canPayOffline derivation) — chosen before Stripe
    // is actually chargeable, it leaves the storefront offering no way to
    // pay at all: the customer's booking goes through with no deposit
    // session (maybeCreateDepositSession silently skips when
    // stripeChargesEnabled is false) and no offline panel either, so
    // nothing ever flags the booking as needing payment. BOTH and
    // MANUAL_OFFLINE are safe regardless of Stripe status and stay allowed.
    // Only guard an actual change to ONLINE_CARD — a business already in
    // that state (set before this guard existed, or Stripe disconnected
    // afterward) must still be able to save an unrelated field, like
    // updating offline instructions, without being blocked by a preference
    // they didn't touch this time.
    if (
        data.preferredPaymentCollection === 'ONLINE_CARD' &&
        data.preferredPaymentCollection !== b.preferredPaymentCollection &&
        !b.stripeChargesEnabled
    ) {
      const err = new Error(
          "Card payments are not enabled on this account yet, so 'card only' is not available — " +
          "choose 'Card (when available) + offline' or 'Offline only' so customers always have a way to pay."
      );
      err.status = 422;
      throw err;
    }
  }

  if ('offlinePaymentInstructions' in data) {
    const raw = data.offlinePaymentInstructions;
    data.offlinePaymentInstructions =
        raw == null || String(raw).trim() === ''
            ? null
            : String(raw).trim().slice(0, 4000);
  }

  // Normalize empty string → null so "" and null are the same "no domain"
  if ('customDomain' in data) {
    const normalized =
        data.customDomain && String(data.customDomain).trim()
            ? String(data.customDomain).trim().toLowerCase()
            : null;
    data.customDomain = normalized;

    const current = b.customDomain || null;
    if (normalized !== current) {
      // Only gate when *setting* a domain, not when clearing it
      if (normalized) {
        const { hasPlanFeature } = require('../../lib/planFeatures');
        const allowed = await hasPlanFeature(businessId, 'customDomain');
        if (!allowed) {
          const err = new Error(
              "Custom domains aren't included in your current plan. Upgrade to Pro to use one."
          );
          err.status = 402;
          throw err;
        }
      }
    }
  }

  const updatedBusiness = await prisma.business.update({ where: { id: businessId }, data });
  void revalidateStorefront(businessId);
  return updatedBusiness;
}

// Resolves stored S3 keys into permanent public URLs for anything the
// dashboard or public site actually renders as an <img> — see
// lib/branding.js (shared with widget.service, which needs the same
// resolution for the public storefront).

async function getBranding(businessId) {
  const branding = await prisma.businessBranding.findUnique({ where: { businessId } });
  return toPublicBranding(branding);
}

const THEME_STYLES = ['MODERN', 'CLASSIC', 'BOLD'];
const SOCIAL_PLATFORMS = ['facebook', 'instagram', 'tiktok', 'linkedin', 'twitter'];
const SECTION_KEYS = ['about', 'testimonials', 'gallery', 'faq'];
// Presigned uploads write straight to Spaces from the browser, so nothing
// stops a client from requesting a URL for any key it likes — namespacing
// every key under businesses/<businessId>/branding/ at least keeps one
// business's uploads from being able to collide with or overwrite
// another's by guessing a key, even though the presign itself doesn't
// check who's asking for what path beyond that prefix.
function brandingAssetKey(businessId, kind, filename) {
  const ext = (filename || '').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  return `businesses/${businessId}/branding/${kind}-${crypto.randomUUID()}.${ext}`;
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateBrandingPayload(payload, businessId) {
  // Branding assets are referenced by key and rendered from a public URL, so a
  // key must be one this business was issued by brandingUploadUrl.
  if (businessId) {
    const brandingPrefix = prefixes.branding(businessId);
    for (const field of ['logoKey', 'heroImageKey']) {
      if (payload[field]) assertKeyUnderPrefix(payload[field], brandingPrefix, field);
    }
    if (Array.isArray(payload.galleryImageKeys)) {
      for (const k of payload.galleryImageKeys) assertKeyUnderPrefix(k, brandingPrefix, 'galleryImageKeys');
    }
  }
  if (payload.themeStyle !== undefined && !THEME_STYLES.includes(payload.themeStyle)) {
    const err = new Error(`themeStyle must be one of ${THEME_STYLES.join(', ')}`);
    err.status = 422;
    throw err;
  }
  if (payload.testimonials !== undefined && payload.testimonials !== null) {
    if (!Array.isArray(payload.testimonials) || payload.testimonials.some((t) => typeof t?.name !== 'string' || typeof t?.quote !== 'string')) {
      const err = new Error('testimonials must be an array of { name, quote }');
      err.status = 422;
      throw err;
    }
  }
  if (payload.faqItems !== undefined && payload.faqItems !== null) {
    if (!Array.isArray(payload.faqItems) || payload.faqItems.some((f) => typeof f?.question !== 'string' || typeof f?.answer !== 'string')) {
      const err = new Error('faqItems must be an array of { question, answer }');
      err.status = 422;
      throw err;
    }
  }
  if (payload.socialLinks !== undefined && payload.socialLinks !== null) {
    if (typeof payload.socialLinks !== 'object' || Array.isArray(payload.socialLinks)) {
      const err = new Error('socialLinks must be an object');
      err.status = 422;
      throw err;
    }
    for (const [key, value] of Object.entries(payload.socialLinks)) {
      if (!SOCIAL_PLATFORMS.includes(key)) {
        const err = new Error(`socialLinks.${key} is not a supported platform`);
        err.status = 422;
        throw err;
      }
      if (value && !isHttpUrl(value)) {
        const err = new Error(`socialLinks.${key} must be a valid URL`);
        err.status = 422;
        throw err;
      }
    }
  }
  if (payload.sectionsEnabled !== undefined && payload.sectionsEnabled !== null) {
    const se = payload.sectionsEnabled;
    if (typeof se !== 'object' || Array.isArray(se)) {
      const err = new Error('sectionsEnabled must be an object');
      err.status = 422;
      throw err;
    }
    for (const key of Object.keys(se)) {
      if (key !== 'order' && !SECTION_KEYS.includes(key)) {
        const err = new Error(`sectionsEnabled.${key} is not a recognized section`);
        err.status = 422;
        throw err;
      }
    }
    if (se.order !== undefined) {
      if (!Array.isArray(se.order) || se.order.some((k) => !SECTION_KEYS.includes(k))) {
        const err = new Error(`sectionsEnabled.order must only contain ${SECTION_KEYS.join(', ')}`);
        err.status = 422;
        throw err;
      }
    }
  }
  if (payload.galleryImageKeys !== undefined && payload.galleryImageKeys !== null) {
    if (!Array.isArray(payload.galleryImageKeys) || payload.galleryImageKeys.some((k) => typeof k !== 'string')) {
      const err = new Error('galleryImageKeys must be an array of strings');
      err.status = 422;
      throw err;
    }
    if (payload.galleryImageKeys.length > 24) {
      const err = new Error('galleryImageKeys cannot exceed 24 images');
      err.status = 422;
      throw err;
    }
  }
}

// A presigned upload URL for a public branding asset (logo, site hero
// image, or one gallery photo) — mirrors the shape of the private-document
// upload flow in cleanerSelf.service, but writes public-read so the
// public site can reference the result by a permanent URL forever
// instead of a signed one that expires.
async function brandingUploadUrl(businessId, { kind, filename, contentType }) {
  const type = assertContentType(contentType, PUBLIC_IMAGE_TYPES);
  if (!['logo', 'hero', 'gallery'].includes(kind)) {
    const err = new Error('kind must be one of logo, hero, gallery');
    err.status = 422;
    throw err;
  }
  const key = brandingAssetKey(businessId, kind, filename);
  const uploadUrl = await getPublicUploadUrl(key, type);
  return { key, uploadUrl, publicUrl: getPublicUrl(key) };
}

/**
 * Read-only: can this business take card payments, and what is its payment
 * preference. Lady Greener charges on its own Stripe account (see
 * lib/stripeClient.js DIRECT_ACCOUNT), so there is nothing to connect.
 */
async function getPaymentStatus(businessId) {
  const b = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      stripeConnectedAccountId: true,
      stripeConnectOnboarded: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      preferredPaymentCollection: true,
      offlinePaymentInstructions: true,
    },
  });
  if (!b) {
    const err = new Error('Business not found');
    err.status = 404;
    throw err;
  }

  const onlineCardReady =
      !!b.stripeChargesEnabled && !!b.stripeConnectedAccountId;
  const preferred = b.preferredPaymentCollection || 'BOTH';
  const prefersOnline =
      preferred === 'ONLINE_CARD' || preferred === 'BOTH';
  const prefersOffline =
      preferred === 'MANUAL_OFFLINE' || preferred === 'BOTH';

  return {
    connected: !!b.stripeConnectedAccountId,
    onboarded: b.stripeConnectOnboarded,
    chargesEnabled: b.stripeChargesEnabled,
    payoutsEnabled: b.stripePayoutsEnabled,
    // kept for existing dashboard code
    readyForPayments: onlineCardReady,

    // Card payments are optional: cash / bank transfer works without them.
    optional: true,
    onlineCardReady,
    canAcceptCardPayments: onlineCardReady && prefersOnline,
    canAcceptOfflinePayments: prefersOffline,
    preferredPaymentCollection: preferred,
    offlinePaymentInstructions: b.offlinePaymentInstructions || null,
    message: onlineCardReady
        ? 'Card payments are enabled via Stripe.'
        : 'Card payments are not enabled yet. You can collect payment by cash or bank transfer and mark bookings paid in the dashboard.',
  };
}

// Previously passed req.body straight into `data` with no field
// whitelist — a request could set `businessId` inside the payload itself
// and, since that's a distinct field from the `where: { businessId }`
// this runs against, silently relocate this branding row onto a
// different business's FK. Explicit picking closes that off and doubles
// as the only validation this endpoint ever had.
const BRANDING_FIELDS = [
  'logoKey', 'primaryColor', 'accentColor', 'tagline', 'widgetEmbedEnabled',
  'themeStyle', 'heroImageKey', 'aboutTitle', 'aboutBody',
  'testimonials', 'faqItems', 'galleryImageKeys', 'socialLinks', 'sectionsEnabled',
];

async function updateBranding(businessId, payload) {
  validateBrandingPayload(payload, businessId);
  const data = {};
  for (const field of BRANDING_FIELDS) {
    if (payload[field] !== undefined) data[field] = payload[field];
  }

  const existing = await prisma.businessBranding.findUnique({ where: { businessId } });
  const saved = existing
      ? await prisma.businessBranding.update({ where: { businessId }, data })
      : await prisma.businessBranding.create({ data: { businessId, ...data } });
  void revalidateStorefront(businessId);
  return toPublicBranding(saved);
}

async function addAddress(businessId, payload) {
  const created = await prisma.businessAddress.create({ data: { ...pick(payload, ADDRESS_FIELDS), businessId } });
  void revalidateStorefront(businessId); // the storefront footer shows the first address
  return created;
}

async function updateAddress(businessId, id, payload) {
  const addr = await prisma.businessAddress.findFirst({ where: { id, businessId } });
  if (!addr) {
    const err = new Error('Address not found');
    err.status = 404;
    throw err;
  }
  const updated = await prisma.businessAddress.update({ where: { id }, data: pick(payload, ADDRESS_FIELDS) });
  void revalidateStorefront(businessId);
  return updated;
}

async function removeAddress(businessId, id) {
  const addr = await prisma.businessAddress.findFirst({ where: { id, businessId } });
  if (!addr) {
    const err = new Error('Address not found');
    err.status = 404;
    throw err;
  }
  const removed = await prisma.businessAddress.delete({ where: { id } });
  void revalidateStorefront(businessId);
  return removed;
}

async function listServiceAreas(businessId) {
  return prisma.serviceArea.findMany({ where: { businessId } });
}

async function createServiceArea(businessId, payload) {
  return prisma.serviceArea.create({ data: { ...pick(payload, SERVICE_AREA_FIELDS), businessId } });
}

async function updateServiceArea(businessId, id, payload) {
  const sa = await prisma.serviceArea.findFirst({ where: { id, businessId } });
  if (!sa) {
    const err = new Error('Service area not found');
    err.status = 404;
    throw err;
  }
  return prisma.serviceArea.update({ where: { id }, data: pick(payload, SERVICE_AREA_FIELDS) });
}

async function deleteServiceArea(businessId, id) {
  const sa = await prisma.serviceArea.findFirst({ where: { id, businessId } });
  if (!sa) {
    const err = new Error('Service area not found');
    err.status = 404;
    throw err;
  }
  return prisma.serviceArea.delete({ where: { id } });
}

async function listHours(businessId) {
  return prisma.businessHours.findMany({ where: { businessId }, orderBy: { dayOfWeek: 'asc' } });
}

async function updateHours(businessId, hours) {
  // hours is an array of { dayOfWeek, openTime, closeTime, isClosed }
  await prisma.businessHours.deleteMany({ where: { businessId } });
  await prisma.businessHours.createMany({ data: hours.map(h => ({ businessId, dayOfWeek: h.dayOfWeek, openTime: h.openTime, closeTime: h.closeTime, isClosed: !!h.isClosed })) });
  void revalidateStorefront(businessId);
  return listHours(businessId);
}

// ============================================================
// ONBOARDING STATUS
// ============================================================
// A business shouldn't go live on the public booking widget (or start
// dispatching cleaners) until the minimum setup is done. Rather than a hard
// server-side block — which would be confusing if it silently 500'd on a
// half-configured business — this exposes a checklist the dashboard uses to
// force new owners through setup before they can use the rest of the app.
const ONBOARDING_STEPS = [
  { key: 'services', label: 'Add at least one service', required: true },
  { key: 'hours', label: 'Set your business hours', required: true },
  { key: 'serviceAreas', label: 'Define at least one service area', required: true },
];

async function getOnboardingStatus(businessId) {
  const [serviceCount, hoursCount, areaCount] = await Promise.all([
    prisma.service.count({ where: { businessId, isActive: true } }),
    prisma.businessHours.count({ where: { businessId } }),
    prisma.serviceArea.count({ where: { businessId } }),
  ]);

  const completed = {
    services: serviceCount > 0,
    hours: hoursCount > 0,
    serviceAreas: areaCount > 0,
  };

  const steps = ONBOARDING_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    required: s.required,
    complete: completed[s.key],
  }));

  // Only required steps block go-live
  const isComplete = steps.filter((s) => s.required).every((s) => s.complete);

  const nextIncompleteRequired =
      steps.find((s) => s.required && !s.complete)?.key || null;
  const nextIncompleteStep =
      nextIncompleteRequired || steps.find((s) => !s.complete)?.key || null;

  return {
    isComplete,
    steps,
    nextIncompleteStep,
    requiredComplete: isComplete,
    optionalStepsRemaining: steps
        .filter((s) => !s.required && !s.complete)
        .map((s) => s.key),
  };
}

module.exports = {
  listBusinesses,
  updateBusiness,
  getBranding,
  updateBranding,
  brandingUploadUrl,
  addAddress,
  updateAddress,
  removeAddress,
  listServiceAreas,
  createServiceArea,
  updateServiceArea,
  deleteServiceArea,
  listHours,
  updateHours,
  // Payments
  getPaymentStatus,
  // Franchise / multi-location
  listLocations,
  createLocation,
  // Onboarding
  getOnboardingStatus,
};
