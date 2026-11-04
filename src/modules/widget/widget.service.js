const prisma = require('../../config/database');
const { normalizePhone, findCustomerByPhone } = require('../../lib/phone');
const { isWithinServiceAreas } = require('../../utils/geo');
const { createAncillaryCheckoutSession } = require('../../lib/stripeClient');
const { toPublicBranding } = require('../../lib/branding');
const { depositHoldMinutes } = require('../../lib/depositHold');
const { assertWithinBusinessHours } = require('../../lib/businessHours');
const { withBusinessLock } = require('../../lib/bookingLock');
const { vatRateFor, splitGross } = require('../../lib/vat');
const { spareCapacity } = require('../../lib/capacity');

/**
 * Creates the deposit Checkout Session for a freshly-created booking, when
 * the business has a deposit policy configured and enough is charged to
 * clear Stripe's minimum. Stores the session id on the booking and returns
 * its checkout URL so the widget can redirect the customer to pay before
 * the booking is treated as confirmed. Returns null (not an error) when no
 * deposit is required, or when the business hasn't finished Stripe Connect
 * onboarding — a booking should still succeed even if card collection
 * isn't available yet; it just stays payable manually.
 */
const crypto = require('crypto');
const logger = require('../../config/logger');
const { getZonedParts, zonedWallTimeToUtc, advanceRunDate } = require('../../utils/timezone');
const { geocodeNl } = require('../../lib/geocode');
const bookingQuestions = require('../bookingQuestions/bookingQuestions.service');

const SLOT_STEP_MINUTES = 30;
const DEFAULT_MIN_NOTICE_HOURS = 2;
const MAX_SLOTS = 96;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Shortest notice a customer can book with, so nobody books a slot that starts in five minutes. BOOKING_MIN_NOTICE_HOURS overrides. */
function minNoticeMs() {
  const h = Number(process.env.BOOKING_MIN_NOTICE_HOURS);
  return (Number.isFinite(h) && h >= 0 ? h : DEFAULT_MIN_NOTICE_HOURS) * 3600 * 1000;
}

async function getBusinessTimezone(businessId) {
  const b = await prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } });
  return (b && b.timezone) || 'Europe/Amsterdam';
}

function formatMoney(cents, currency) {
  return new Intl.NumberFormat(process.env.DEFAULT_LOCALE || 'nl-NL', {
    style: 'currency',
    currency: String(currency || 'eur').toUpperCase(),
  }).format((cents || 0) / 100);
}

/**
 * How many cleaners can still take a job in this window. findAvailableCleaners
 * only looks at *assigned* work, so requests that have not been dispatched yet
 * used to be invisible to it and the same slot could be sold to any number of
 * customers. Subtract the overlapping unassigned bookings from the pool.
 */

/**
 * Re-checked INSIDE the per-business lock right before the booking is written.
 * (quote() checks too, but two requests can both pass that check.)
 */
async function assertCapacity(businessId, start, end, q) {
  const { spare } = await spareCapacity(businessId, start, end, { lat: q.latitude, lng: q.longitude });
  if (spare < 1) throw httpError(409, 'That time was just taken. Please choose another slot.');
}

/**
 * Caps how many bookings one contact can create per day through the public
 * form, so a script cannot fill a calendar (or run up SMS costs) from one
 * phone number. WIDGET_MAX_BOOKINGS_PER_CUSTOMER_PER_DAY overrides.
 */
async function assertCustomerNotSpamming(client, customerId) {
  const limit = Number(process.env.WIDGET_MAX_BOOKINGS_PER_CUSTOMER_PER_DAY) || 5;
  const recent = await client.booking.count({
    where: { customerId, status: { not: 'CANCELLED' }, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
  });
  if (recent >= limit) {
    throw httpError(429, 'Too many bookings for this contact today. Please contact the business directly.');
  }
}

/** Only what the public site and widget render. The full row includes Stripe account ids and internal settings. */
function toPublicBusiness(business) {
  if (!business) return business;
  return {
    id: business.id,
    name: business.name,
    subdomain: business.subdomain,
    // The business's own domain, used as the canonical URL.
    customDomain: business.customDomain || null,
    defaultLocale: business.defaultLocale || 'nl',
    timezone: business.timezone,
    currency: business.currency,
    // Public phone number for the storefront footer. contactEmail is deliberately
    // NOT here: it is where contact-form messages are delivered, and publishing it
    // would let bots skip the captcha-protected form and mail the business directly.
    phone: business.contactPhone || null,
    // Details a Dutch consumer-facing site must show (company registration, VAT
    // id, geographic address). contactEmail stays out on purpose, see above.
    legal: {
      kvkNumber: business.kvkNumber || null,
      vatNumber: business.vatNumber || null,
      address: business.addresses && business.addresses[0]
        ? {
            line1: business.addresses[0].line1,
            postalCode: business.addresses[0].postalCode,
            city: business.addresses[0].city,
            country: business.addresses[0].country,
          }
        : null,
    },
    branding: business.branding,
    hours: (business.hours || []).map((h) => ({
      dayOfWeek: h.dayOfWeek,
      openTime: h.openTime,
      closeTime: h.closeTime,
      isClosed: !!h.isClosed,
    })),
  };
}

/**
 * Coordinates for a booking. Uses what the form sent; otherwise looks the
 * address up. This runs for EVERY booking, not only when the business
 * restricts its service area: the coordinates also drive the cleaner check-in
 * geofence, which silently did nothing for bookings stored without them.
 * Previously the check ran only if the client volunteered latitude/longitude,
 * so omitting them bypassed it.
 */
async function resolveCoordinates(hasAreas, { latitude, longitude, postalCode, addressLine1, city }) {
  if (latitude != null && longitude != null) return { latitude, longitude };
  const found = await geocodeNl({ postalCode, addressLine1, city });
  if (!found && hasAreas) logger.warn('service-area check skipped: address could not be geocoded', { postalCode });
  return found || { latitude: latitude ?? null, longitude: longitude ?? null };
}

async function maybeCreateDepositSession(businessId, booking) {
  const pricing = require('../../lib/pricing');
  const depositRequiredCents = await pricing.computeDepositCents(businessId, booking.quotedPriceCents);
  if (!depositRequiredCents || depositRequiredCents < 50) return null;

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { stripeConnectedAccountId: true, stripeChargesEnabled: true, currency: true, preferredPaymentCollection: true },
  });
  if (!business?.stripeChargesEnabled || !business?.stripeConnectedAccountId) return null;
  // A business that explicitly chose "offline only" must not have customers
  // redirected to Stripe Checkout anyway just because the account happens
  // to still be chargeable (e.g. connected earlier for another reason, or
  // switched to offline-only after connecting) — this used to ignore the
  // preference entirely and always create the online session when Stripe
  // was ready, overriding what the business asked for.
  if (business.preferredPaymentCollection === 'MANUAL_OFFLINE') return null;

  const customer = await prisma.customer.findUnique({ where: { id: booking.customerId } });

  const session = await createAncillaryCheckoutSession({
    purpose: 'deposit',
    bookingId: booking.id,
    businessId,
    connectedAccountId: business.stripeConnectedAccountId,
    amountCents: depositRequiredCents,
    currency: business.currency,
    customerEmail: customer?.email || undefined,
    description: `Deposit for booking ${booking.id}`,
    // The slot is held only while the customer can still pay; an unpaid
    // deposit session expiring cancels the booking (webhook + sweeper).
    expiresInMinutes: depositHoldMinutes(),
  });

  await prisma.booking.update({
    where: { id: booking.id },
    data: { depositRequiredCents, stripeDepositSessionId: session.id },
  });

  return { url: session.url, sessionId: session.id, depositRequiredCents };
}

/**
 * Public balance check for the widget's "apply a gift card" field —
 * intentionally returns the minimum needed to let the customer confirm a
 * code is real and see what's on it, not the full row (no recipient PII,
 * no purchasedByCustomerId).
 */
async function checkGiftCardBalance(businessId, code) {
  const giftCard = await prisma.giftCard.findFirst({
    where: { businessId, code: String(code || '').toUpperCase(), isActive: true },
  });
  if (!giftCard) return { valid: false, reason: 'not_found' };
  if (!giftCard.purchasePaidAt) return { valid: false, reason: 'not_yet_active' };
  if (giftCard.expiresAt && new Date(giftCard.expiresAt) < new Date()) {
    return { valid: false, reason: 'expired' };
  }
  if (giftCard.balanceCents <= 0) return { valid: false, reason: 'zero_balance' };
  return { valid: true, balanceCents: giftCard.balanceCents };
}

/**
 * Redeems a gift card against a just-created booking, best-effort — same
 * "non-fatal, booking still succeeds either way" pattern as
 * maybeCreateDepositSession above. A booking failing because a gift card
 * code had a typo would be a much worse outcome than the booking going
 * through without the discount applied, so callers catch and ignore
 * failures from this rather than letting them fail the whole request.
 *
 * The updateMany's `balanceCents: { gte: appliedCents }` guard is what
 * keeps two near-simultaneous redemptions of the same card from ever
 * pushing its balance negative — one succeeds, the other's updateMany
 * matches zero rows and this returns null rather than double-spending.
 */
async function applyGiftCardToBooking(businessId, booking, giftCardCode) {
  if (!giftCardCode) return null;

  const giftCard = await prisma.giftCard.findFirst({
    where: { businessId, code: String(giftCardCode).toUpperCase(), isActive: true },
  });
  if (!giftCard) return null;
  if (!giftCard.purchasePaidAt) return null;
  if (giftCard.expiresAt && new Date(giftCard.expiresAt) < new Date()) return null;
  if (giftCard.balanceCents <= 0) return null;

  const appliedCents = Math.min(giftCard.balanceCents, booking.quotedPriceCents);
  if (appliedCents <= 0) return null;

  const decremented = await prisma.giftCard.updateMany({
    where: { id: giftCard.id, balanceCents: { gte: appliedCents } },
    data: { balanceCents: { decrement: appliedCents } },
  });
  if (decremented.count === 0) return null; // lost the race — skip, don't double-spend

  await prisma.booking.update({
    where: { id: booking.id },
    data: { giftCardId: giftCard.id, giftCardAppliedCents: appliedCents },
  });

  return { giftCardId: giftCard.id, appliedCents };
}

/**
 * Finds or creates the customer for an anonymous booking, keyed by phone.
 *
 * An existing customer is returned untouched. The previous code overwrote
 * firstName/lastName/email from the public form, so anyone who knew a
 * customer's phone number could replace their email with their own and then
 * receive that customer's portal one-time codes. Contact details are only
 * ever changed by the customer through a verified flow or by the business
 * from the dashboard.
 */
async function upsertGuestCustomer(client, businessId, { firstName, lastName, email, phone }) {
  // The same person types their number several ways; match every stored form so
  // a booking never creates a duplicate customer, then store new customers in
  // normalised form (see lib/phone.js).
  const existing = await findCustomerByPhone(client, businessId, phone);
  if (existing) return existing;
  const normalized = normalizePhone(phone);
  return client.customer.upsert({
    where: { businessId_phone: { businessId, phone: normalized } },
    update: {},
    create: { businessId, firstName, lastName, email, phone: normalized },
  });
}

async function getStorefront(businessId) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      branding: true,
      hours: true,
      // Registered/primary address first, for the legal footer.
      addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1 },
    },
  });
  if (business?.branding) {
    business.branding = toPublicBranding(business.branding);
  }
  const services = await prisma.service.findMany({
    where: { businessId, isActive: true },
    include: { addOns: true },
  });
  const areaCount = await prisma.serviceArea.count({ where: { businessId } });
  const onboardingComplete =
      services.length > 0 && business?.hours?.length > 0 && areaCount > 0;

  const onlineCardReady =
      !!business?.stripeChargesEnabled && !!business?.stripeConnectedAccountId;
  const preferred = business?.preferredPaymentCollection || 'BOTH';
  const canPayByCard =
      onlineCardReady && (preferred === 'ONLINE_CARD' || preferred === 'BOTH');
  // Belt-and-braces on top of the ONLINE_CARD write-guard in
  // businesses.service.updateBusiness (which stops this preference being
  // *set* before Stripe is chargeable): if a business set ONLINE_CARD while
  // connected and then Stripe later stops being chargeable (disconnected,
  // restricted, a failed re-verification), this must not silently leave a
  // storefront where neither online nor offline payment is available —
  // that's a booking with no way to ever get paid. Offline always opens up
  // as the fallback when card isn't actually usable, regardless of what the
  // stored preference says.
  const canPayOffline =
      preferred === 'MANUAL_OFFLINE' || preferred === 'BOTH' || !canPayByCard;

  // The widget used to show a hardcoded "cancel free up to 12 hours before"
  // regardless of what this business actually has configured (including
  // businesses with no fee at all) — a real risk of the storefront telling
  // a customer one policy while cancellationPolicy.js enforces another.
  // null cancellationWindowHours here means "free anytime", matching
  // evaluateCancellation's own default.
  const pricing = await prisma.businessPricing.findUnique({ where: { businessId } });

  // The business's own booking-form questions (empty array when none).
  const questions = await bookingQuestions.listPublic(businessId);

  return {
    business: toPublicBusiness(business),
    services,
    questions,
    onboardingComplete,
    payment: {
      onlineCardReady: canPayByCard,
      offlineAccepted: canPayOffline,
      offlinePaymentInstructions: business?.offlinePaymentInstructions || null,
    },
    cancellationPolicy: {
      windowHours: pricing?.cancellationWindowHours ?? null,
      feeType: pricing?.cancellationFeeType ?? null,
      feeValue: pricing?.cancellationFeeValue ?? null,
    },
  };
}

const POSTCODE_RE = /^[1-9]\d{3}\s?[A-Za-z]{2}$/;
const AREA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const AREA_CACHE_MAX = 5000;
const postcodeCoords = new Map(); // normalised postcode -> { at, coords }

async function coordsForPostcode(postalCode) {
  const hit = postcodeCoords.get(postalCode);
  if (hit && Date.now() - hit.at < AREA_CACHE_TTL_MS) return hit.coords;
  const coords = await geocodeNl({ postalCode });
  // Only successes are cached: a geocoder hiccup must not stick for six hours.
  if (coords) {
    if (postcodeCoords.size >= AREA_CACHE_MAX) postcodeCoords.delete(postcodeCoords.keys().next().value);
    postcodeCoords.set(postalCode, { at: Date.now(), coords });
  }
  return coords;
}

/**
 * "Do you clean in my postcode?" - asked before the customer has picked a
 * service or typed an address, so they find out in seconds instead of at the
 * end of the booking form.
 *
 *   covered: true  - inside a service area, or the business has not restricted
 *                    its area (restricted: false)
 *   covered: false - outside every service area
 *   covered: null  - could not be verified (geocoder down / unknown postcode).
 *                    Same stance as quote(): never claim either way.
 *
 * Postcode granularity: coordinates are those of one address in the postcode,
 * so a postcode straddling a service-area border can answer either way. The
 * booking form re-checks with the full address.
 */
async function checkServiceArea(businessId, { postalCode } = {}) {
  const raw = String(postalCode || '').trim();
  if (!POSTCODE_RE.test(raw)) throw httpError(422, 'Enter a valid Dutch postcode, like 1012 AB');
  const normalized = raw.replace(/\s/g, '').toUpperCase();

  const areas = await prisma.serviceArea.findMany({ where: { businessId } });
  if (!areas.length) return { postalCode: normalized, covered: true, restricted: false };

  const coords = await coordsForPostcode(normalized);
  if (!coords || coords.latitude == null || coords.longitude == null) {
    return { postalCode: normalized, covered: null, restricted: true };
  }
  return {
    postalCode: normalized,
    covered: isWithinServiceAreas(coords.latitude, coords.longitude, areas),
    restricted: true,
  };
}

async function quote(businessId, {
  serviceId,
  addOnIds = [],
  latitude,
  longitude,
  postalCode,
  addressLine1,
  city,
  scheduledStart,
  couponCode,
  giftCardCode,
  rooms,
  bathrooms,
  sqft,
  frequency,
} = {}) {
  const service = await prisma.service.findFirst({
    where: { id: serviceId, businessId, isActive: true },
    include: { addOns: true },
  });
  if (!service) throw httpError(404, 'Service not found');

  const areas = await prisma.serviceArea.findMany({ where: { businessId } });
  const coords = await resolveCoordinates(areas.length > 0, { latitude, longitude, postalCode, addressLine1, city });
  if (areas.length && coords.latitude != null && coords.longitude != null
      && !isWithinServiceAreas(coords.latitude, coords.longitude, areas)) {
    throw httpError(422, "This address is outside the business's service area");
  }

  const pricing = require('../../lib/pricing');
  const quote = await pricing.calculateQuote(service, {
    businessId,
    addOnIds,
    scheduledStart,
    couponCode,
    giftCardCode,
    rooms,
    bathrooms,
    sqft,
    frequency,
  });

  if (scheduledStart) {
    const start = new Date(scheduledStart);
    if (Number.isNaN(start.getTime())) throw httpError(422, 'scheduledStart is not a valid date');
    if (start.getTime() < Date.now() + minNoticeMs()) {
      const hours = Math.round(minNoticeMs() / 3600000);
      throw httpError(422, `Please choose a time at least ${hours} hour${hours === 1 ? '' : 's'} from now`);
    }
    const end = new Date(start.getTime() + (quote.breakdown.estimatedMinutes || 60) * 60 * 1000);
    await assertWithinBusinessHours(businessId, start, end, await getBusinessTimezone(businessId));
    const { spare } = await spareCapacity(businessId, start, end, { lat: coords.latitude, lng: coords.longitude });
    if (spare < 1) throw httpError(422, 'No cleaners available for the requested scheduledStart');
  }

  const { computeDepositCents } = pricing;
  const depositRequiredCents = await computeDepositCents(businessId, quote.priceCents);

  // Prices are VAT-inclusive; tell the client how much of the total is BTW so it
  // can show "incl. 21% BTW". This never changes the amount charged.
  const taxBusiness = await prisma.business.findUnique({ where: { id: businessId }, select: { vatRateBps: true } });
  const vat = splitGross(quote.priceCents, vatRateFor(service, taxBusiness));

  const chosen = new Set(addOnIds || []);
  return {
    serviceId,
    addOnIds,
    // Frozen copy of the selected add-ons for the booking record.
    addOns: service.addOns
      .filter((a) => chosen.has(a.id))
      .map((a) => ({ id: a.id, name: a.name, priceCents: a.priceCents, extraMinutes: a.extraMinutes })),
    latitude: coords.latitude,
    longitude: coords.longitude,
    priceCents: quote.priceCents,
    estimatedMinutes: quote.breakdown.estimatedMinutes,
    breakdown: quote.breakdown,
    coupon: quote.coupon,
    giftCard: quote.giftCard,
    depositRequiredCents: depositRequiredCents || 0,
    tax: { pricesIncludeVat: true, vatRateBps: vat.vatRateBps, vatCents: vat.vatCents, netCents: vat.netCents },
  };
}

/**
 * Creates the customer record (find-or-create, scoped to this business) and
 * the booking in one go — the widget's main conversion action.
 */
/**
 * Turns an accepted quote plus the form payload into the booking row. The
 * pricing inputs (rooms, bathrooms, sqft, frequency), add-ons, postcode and
 * the customer's notes used to be dropped here even though the form sent them.
 */
function buildBookingData({ businessId, customerId, serviceId, payload, q, start, end, priceCents, extra = {} }) {
  const {
    addressLine1, addressLine2, city, state, postalCode,
    accessCode, keyLocation, parkingInstructions, petNotes, specialInstructions, notes,
    rooms, bathrooms, sqft, frequency, customAnswers,
  } = payload;

  const homeDetails = Object.fromEntries(
    Object.entries({ rooms, bathrooms, sqft, frequency }).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
  const instructions = [specialInstructions, notes].filter((t) => t && String(t).trim()).join('\n\n');

  return {
    businessId,
    customerId,
    serviceId,
    addressLine1,
    addressLine2,
    city,
    state: state || '',
    postalCode: postalCode || null,
    latitude: q.latitude ?? null,
    longitude: q.longitude ?? null,
    accessCode,
    keyLocation,
    parkingInstructions,
    petNotes,
    specialInstructions: instructions || undefined,
    customAnswers: customAnswers && customAnswers.length ? customAnswers : undefined,
    addOns: q.addOns && q.addOns.length ? q.addOns : undefined,
    homeDetails: Object.keys(homeDetails).length ? homeDetails : undefined,
    scheduledStart: start,
    scheduledEnd: end,
    quotedPriceCents: priceCents,
    status: 'REQUESTED',
    ...extra,
  };
}

/**
 * The customer picked weekly/bi-weekly/monthly and the price already reflects
 * that discount, so there has to be a schedule to honour it. Previously the
 * form's "weekly" produced one single job. This booking is the first
 * occurrence; the schedule's next run is one interval later.
 */
async function maybeCreateRecurringSchedule(businessId, booking, customer, frequency) {
  if (!['WEEKLY', 'BIWEEKLY', 'MONTHLY'].includes(frequency)) return null;
  try {
    const tz = await getBusinessTimezone(businessId);
    const local = getZonedParts(booking.scheduledStart, tz);
    const dayOfWeek = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
    const pad = (n) => String(n).padStart(2, '0');
    const startTime = `${pad(local.hour)}:${pad(local.minute)}`;

    const address = await prisma.customerAddress.create({
      data: {
        customerId: customer.id,
        line1: booking.addressLine1,
        line2: booking.addressLine2 || null,
        city: booking.city,
        state: booking.state || '',
        postalCode: booking.postalCode || '',
        latitude: booking.latitude,
        longitude: booking.longitude,
        accessCode: booking.accessCode,
        keyLocation: booking.keyLocation,
        parkingInstructions: booking.parkingInstructions,
        petNotes: booking.petNotes,
      },
    });
    const schedule = await prisma.recurringSchedule.create({
      data: {
        businessId,
        customerId: customer.id,
        serviceId: booking.serviceId,
        customerAddressId: address.id,
        frequency,
        dayOfWeek,
        startTime,
        nextRunDate: advanceRunDate(booking.scheduledStart, frequency, startTime, tz),
      },
    });
    await prisma.booking.update({ where: { id: booking.id }, data: { recurringScheduleId: schedule.id } });
    return schedule;
  } catch (e) {
    logger.error('could not create recurring schedule from widget booking', { bookingId: booking.id, error: e.message });
    return null;
  }
}

/**
 * Creates the customer record (find-or-create, scoped to this business) and
 * the booking in one go — the widget's main conversion action.
 */
async function submitBooking(businessId, payload) {
  const {
    firstName, lastName, email, phone,
    addressLine1, city, postalCode,
    serviceId, addOnIds = [], scheduledStart,
    couponCode, giftCardCode, referralCode,
    rooms, bathrooms, sqft, frequency,
  } = payload;

  if (!scheduledStart || Number.isNaN(new Date(scheduledStart).getTime())) throw httpError(422, 'scheduledStart is required');

  // The business's own questions: validated here, BEFORE pricing or locking, so a
  // missing required answer is a quick 422 and nothing is held. Stored as a
  // snapshot (question text included) on the booking.
  payload = { ...payload, customAnswers: await bookingQuestions.resolveForBooking(businessId, serviceId, payload.answers) };

  // Price using the same inputs the customer saw in the live quote. This call
  // used to omit rooms/bathrooms/sqft/frequency, so per-room and per-sqft
  // services were booked at the base price whatever the quote said.
  const q = await quote(businessId, {
    serviceId, addOnIds, scheduledStart, couponCode, giftCardCode,
    latitude: payload.latitude, longitude: payload.longitude, postalCode, addressLine1, city,
    rooms, bathrooms, sqft, frequency,
  });
  const { priceCents, estimatedMinutes, coupon: couponInfo } = q;
  const start = new Date(scheduledStart);
  const end = new Date(start.getTime() + estimatedMinutes * 60 * 1000);

  // handle booking + coupon redemption atomically when couponCode provided
  if (couponCode) {
    const coupon = await prisma.coupon.findFirst({ where: { businessId, code: couponCode, isActive: true } });
    if (!coupon) throw httpError(422, 'Coupon not found');
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) throw httpError(422, 'Coupon expired');
    if (coupon.appliesToServiceId && coupon.appliesToServiceId !== serviceId) throw httpError(422, 'Coupon not applicable to this service');

    const result = await withBusinessLock(businessId, async (tx) => {
      await assertCapacity(businessId, start, end, q);
      const cust = await upsertGuestCustomer(tx, businessId, { firstName, lastName, email, phone });
      await assertCustomerNotSpamming(tx, cust.id);

      if (coupon.perCustomerLimit) {
        const used = await tx.booking.count({ where: { customerId: cust.id, couponId: coupon.id } });
        if (used >= coupon.perCustomerLimit) throw httpError(422, 'Coupon per-customer redemption limit reached');
      }

      const b = await tx.booking.create({
        data: buildBookingData({ businessId, customerId: cust.id, serviceId, payload, q, start, end, priceCents, extra: { couponId: coupon.id } }),
      });

      if (coupon.maxRedemptions) {
        const updated = await tx.coupon.updateMany({ where: { id: coupon.id, redeemedCount: { lt: coupon.maxRedemptions } }, data: { redeemedCount: { increment: 1 } } });
        if (updated.count === 0) throw httpError(409, 'Coupon redemption limit reached');
      } else {
        await tx.coupon.update({ where: { id: coupon.id }, data: { redeemedCount: { increment: 1 } } });
      }

      return { booking: b, customer: cust };
    });

    const booking = result.booking;
    const customer = result.customer;
    try { const notifications = require('../notifications/notifications.service'); await notifications.notifyBookingCreated(businessId, booking); await notifications.sendCustomerBookingConfirmation(businessId, booking, customer); } catch (e) {}
    await maybeCreateRecurringSchedule(businessId, booking, customer, frequency);
    let deposit = null;
    try { deposit = await maybeCreateDepositSession(businessId, booking); } catch (e) { /* non-fatal — booking still succeeds without card collection */ }
    let giftCard = null;
    try { giftCard = await applyGiftCardToBooking(businessId, booking, giftCardCode); } catch (e) { /* non-fatal — booking still succeeds without the gift card applied */ }
    return { ...booking, deposit, giftCard };
  }

  // Referral program (only when no manual coupon was applied — the two
  // discounts aren't designed to stack, to keep the pricing math and the
  // reward-issuing logic below from getting tangled with coupon redemption
  // limits).
  // Amounts live in lib/referral.js ("Give €20, Get €20").
  const { REFERRAL_DISCOUNT_CENTS, REFERRAL_REWARD_CENTS, REFERRAL_REWARD_VALID_DAYS } = require('../../lib/referral');

  const { booking, customer, referrer, referralDiscountCents } = await withBusinessLock(businessId, async (tx) => {
    await assertCapacity(businessId, start, end, q);

    const existingCustomer = await tx.customer.findFirst({ where: { businessId, phone } });
    let ref = null;
    if (referralCode && !existingCustomer) {
      ref = await tx.customer.findFirst({ where: { businessId, referralCode: referralCode.toUpperCase() } });
      // A customer cannot refer themselves under a second phone number, or
      // reuse their own e-mail address to farm the discount.
      if (ref && (ref.phone === phone || (ref.email && email && ref.email.toLowerCase() === String(email).toLowerCase()))) ref = null;
    }
    const discount = ref ? Math.min(REFERRAL_DISCOUNT_CENTS, priceCents) : 0;

    const cust = await upsertGuestCustomer(tx, businessId, { firstName, lastName, email, phone });
    await assertCustomerNotSpamming(tx, cust.id);

    const b = await tx.booking.create({
      data: buildBookingData({
        businessId, customerId: cust.id, serviceId, payload, q, start, end,
        priceCents: priceCents - discount,
        extra: { referredByCustomerId: ref?.id || null },
      }),
    });
    return { booking: b, customer: cust, referrer: ref, referralDiscountCents: discount };
  });
  const customerReferralCode = customer.referralCode || (await require('../customers/customers.service').ensureReferralCode(customer.id));

  // Notify business dashboard (Socket.io) + confirmation email/SMS to customer
  try {
    const notifications = require('../notifications/notifications.service');
    await notifications.notifyBookingCreated(businessId, booking);
    await notifications.sendCustomerBookingConfirmation(businessId, booking, customer);
  } catch (e) {
    // non-fatal
  }

  await maybeCreateRecurringSchedule(businessId, booking, customer, frequency);

  // Reward the referrer with a single-use coupon, delivered only to them via
  // SMS/email — there's no per-customer scoping column on Coupon, so a
  // freshly generated, only-shared-with-them code is what keeps this
  // effectively "theirs" rather than a code anyone could guess and use.
  if (referrer) {
    try {
      const rewardCode = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      await prisma.coupon.create({
        data: {
          businessId,
          code: rewardCode,
          type: 'AMOUNT',
          value: REFERRAL_REWARD_CENTS,
          maxRedemptions: 1,
          // Lets the referrer see this reward in their customer portal.
          ownerCustomerId: referrer.id,
          expiresAt: new Date(Date.now() + REFERRAL_REWARD_VALID_DAYS * 24 * 60 * 60 * 1000),
        },
      });
      const notificationClient = require('../../lib/notificationClient');
      const business = await prisma.business.findUnique({ where: { id: businessId } });
      const rewardMsg = `${business.name}: thanks for the referral! Use code ${rewardCode} for ${formatMoney(REFERRAL_REWARD_CENTS, business.currency)} off your next booking.`;
      if (referrer.phone) await notificationClient.sendSms({ to: referrer.phone, body: rewardMsg });
      if (referrer.email) await notificationClient.sendEmail({ to: referrer.email, subject: `${business.name}: your referral reward`, text: rewardMsg, html: `<p>${rewardMsg}</p>` });
    } catch (e) {
      // non-fatal — the referred customer's discount already applied regardless
    }
  }

  let deposit = null;
  try { deposit = await maybeCreateDepositSession(businessId, booking); } catch (e) { /* non-fatal */ }
  let giftCard = null;
  try { giftCard = await applyGiftCardToBooking(businessId, booking, giftCardCode); } catch (e) { /* non-fatal — booking still succeeds without the gift card applied */ }
  return { ...booking, deposit, giftCard, referralCode: customerReferralCode, referralDiscountCents };
}

module.exports = {
  getStorefront,
  quote,
  checkServiceArea,
  submitBooking,
  maybeCreateDepositSession,
  checkGiftCardBalance,
  applyGiftCardToBooking,
  upsertGuestCustomer,
  toPublicBusiness,
  assertCustomerNotSpamming,
};

/**
 * Return available time slots for a given date and service.
 * Query: ?serviceId=&date=YYYY-MM-DD&addOnIds=a,b&slotMinutes=&limit=
 *
 * The date and the opening hours are interpreted in the BUSINESS timezone and
 * returned as UTC instants (plus the timezone, so a client can render local
 * times). Slot length defaults to the service's duration including any
 * chosen add-ons — a 4-hour deep clean used to be offered as 1-hour slots and
 * then rejected at submit because the real window had no free cleaner.
 */
async function slots(businessId, query) {
  const { serviceId, date, slotMinutes, addOnIds } = query;
  if (!serviceId) throw httpError(422, 'serviceId is required');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(422, 'date must be YYYY-MM-DD');

  const svc = await prisma.service.findFirst({ where: { id: serviceId, businessId, isActive: true }, include: { addOns: true } });
  if (!svc) throw httpError(404, 'Service not found');

  const tz = await getBusinessTimezone(businessId);
  const nowLocal = getZonedParts(new Date(), tz);
  const [y, m, d] = date
    ? date.split('-').map(Number)
    : [nowLocal.year, nowLocal.month, nowLocal.day];
  const dateKey = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  const chosenIds = new Set(String(addOnIds || '').split(',').map((x) => x.trim()).filter(Boolean));
  const addOnMinutes = svc.addOns.filter((a) => chosenIds.has(a.id)).reduce((sum, a) => sum + (a.extraMinutes || 0), 0);
  const slotLen = parseInt(slotMinutes, 10) > 0
    ? parseInt(slotMinutes, 10)
    : (svc.estimatedMinutes || 60) + addOnMinutes;

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 48, 1), MAX_SLOTS);

  const cache = require('../../lib/cache');
  const redisKey = `slots:${businessId}:${serviceId}:${dateKey}:${slotLen}`;
  const cached = await cache.get(redisKey);
  const earliest = Date.now() + minNoticeMs();
  if (cached) {
    return { date: dateKey, timezone: tz, slots: cached.filter((sl) => new Date(sl.start).getTime() >= earliest) };
  }

  const businessHours = await prisma.businessHours.findMany({ where: { businessId, dayOfWeek, isClosed: false } });
  const out = [];
  const seen = new Map();

  for (const h of businessHours) {
    const [oh, om] = h.openTime.split(':').map(Number);
    const [ch, cm] = h.closeTime.split(':').map(Number);
    const openMin = oh * 60 + (om || 0);
    let closeMin = ch * 60 + (cm || 0);
    if (closeMin <= openMin) closeMin += 24 * 60; // closes after midnight

    for (let mins = openMin; mins + slotLen <= closeMin; mins += SLOT_STEP_MINUTES) {
      // Wall-clock -> UTC per slot, so a DST change inside the day is correct.
      const slotStart = zonedWallTimeToUtc(y, m, d, Math.floor(mins / 60), mins % 60, tz);
      if (slotStart.getTime() < earliest) continue; // past, or inside the minimum notice
      const slotEnd = new Date(slotStart.getTime() + slotLen * 60000);
      const key = slotStart.toISOString();
      let spare = seen.get(key);
      if (spare === undefined) {
        ({ spare } = await spareCapacity(businessId, slotStart, slotEnd, {}));
        seen.set(key, spare);
      }
      if (spare > 0) out.push({ start: slotStart.toISOString(), end: slotEnd.toISOString(), available: spare });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }

  try { await cache.set(redisKey, out, 30); } catch (e) { /* cache is best-effort */ }
  return { date: dateKey, timezone: tz, slots: out };
}

module.exports.slots = slots;
