/**
 * Dynamic travel fee.
 *
 * A business can charge for distance: the first `travelFreeKm` kilometres
 * around its base are free, every further kilometre costs `travelFeePerKmCents`,
 * and the fee never exceeds `travelFeeMaxCents` (when set). The fee is added to
 * the quote AFTER coupons and frequency discounts (a "10% off" coupon should
 * not discount the cost of driving) and is VAT-inclusive like every other price.
 *
 * Distance is measured from the business's base (its primary address) to the
 * customer's address. When a routing key is configured the real driving
 * distance is used; otherwise straight-line distance x 1.3, the usual
 * crow-flies-to-road factor for Dutch cities. A failure anywhere here must
 * never block a quote: the fee is simply 0 and a warning is logged.
 */
const prisma = require('../config/database');
const logger = require('../config/logger');
const { distanceMeters } = require('../utils/geo');

const ROAD_FACTOR = 1.3;
const DEPOT_TTL_MS = 6 * 60 * 60 * 1000;
const depotCache = new Map(); // businessId -> { at, depot }

/** Pure: the fee for a distance under a business's settings. */
function computeTravelFee({ distanceMeters: meters, freeKm, perKmCents, maxCents } = {}) {
  const perKm = Number(perKmCents) || 0;
  if (!(perKm > 0) || meters == null || !Number.isFinite(meters)) {
    return { cents: 0, distanceKm: meters != null ? round1(meters / 1000) : null, billableKm: 0 };
  }
  const km = meters / 1000;
  const billableKm = Math.max(0, km - (Number(freeKm) || 0));
  let cents = Math.round(billableKm * perKm);
  // Whole 10-cent steps read better on a quote than 1-cent precision.
  cents = Math.round(cents / 10) * 10;
  if (maxCents != null && Number.isFinite(Number(maxCents))) cents = Math.min(cents, Number(maxCents));
  return { cents: Math.max(0, cents), distanceKm: round1(km), billableKm: round1(billableKm) };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** Whether the business has switched the travel fee on. */
function isTravelFeeEnabled(bp) {
  return !!bp && Number(bp.travelFeePerKmCents) > 0;
}

/** The business's base point: primary address coordinates, geocoded once if missing. */
async function resolveDepot(businessId) {
  const hit = depotCache.get(businessId);
  if (hit && Date.now() - hit.at < DEPOT_TTL_MS) return hit.depot;

  let depot = null;
  const addresses = await prisma.businessAddress.findMany({
    where: { businessId },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  const withCoords = addresses.find((a) => a.latitude != null && a.longitude != null);
  if (withCoords) {
    depot = { lat: withCoords.latitude, lng: withCoords.longitude };
  } else if (addresses[0]) {
    const { geocodeNl } = require('./geocode');
    const found = await geocodeNl({
      postalCode: addresses[0].postalCode,
      addressLine1: addresses[0].line1,
      city: addresses[0].city,
    });
    if (found) depot = { lat: found.latitude, lng: found.longitude };
  }
  // Only cache successes: a geocoder hiccup must not stick for six hours.
  if (depot) depotCache.set(businessId, { at: Date.now(), depot });
  return depot;
}

/** Driving distance when a routing key is configured, else estimated from the straight line. */
async function travelDistanceMeters(from, to) {
  try {
    const dd = await require('./distance').distanceAndDuration(from, to);
    if (dd && dd.distanceMeters != null) return { meters: dd.distanceMeters, source: 'route' };
  } catch (e) {
    /* fall through to the estimate */
  }
  return {
    meters: Math.round(distanceMeters(from.lat, from.lng, to.lat, to.lng) * ROAD_FACTOR),
    source: 'estimate',
  };
}

/**
 * Travel fee for an address, given the business's BusinessPricing row.
 * Returns { enabled, cents, distanceMeters, distanceKm, billableKm, freeKm, perKmCents, source }.
 */
async function travelFeeFor(businessId, bp, { latitude, longitude } = {}) {
  const off = { enabled: false, cents: 0, distanceMeters: null };
  if (!isTravelFeeEnabled(bp)) return off;
  if (latitude == null || longitude == null) return { ...off, enabled: true };
  try {
    const depot = await resolveDepot(businessId);
    if (!depot) return { ...off, enabled: true };
    const { meters, source } = await travelDistanceMeters(depot, { lat: latitude, lng: longitude });
    const fee = computeTravelFee({
      distanceMeters: meters,
      freeKm: bp.travelFreeKm,
      perKmCents: bp.travelFeePerKmCents,
      maxCents: bp.travelFeeMaxCents,
    });
    return {
      enabled: true,
      cents: fee.cents,
      distanceMeters: Math.round(meters),
      distanceKm: fee.distanceKm,
      billableKm: fee.billableKm,
      freeKm: bp.travelFreeKm || 0,
      perKmCents: bp.travelFeePerKmCents,
      source,
    };
  } catch (e) {
    logger.warn('travel fee calculation failed; charging none', { businessId, error: e.message });
    return { ...off, enabled: true };
  }
}

function _clearDepotCache() {
  depotCache.clear();
}

module.exports = { computeTravelFee, isTravelFeeEnabled, travelFeeFor, resolveDepot, ROAD_FACTOR, _clearDepotCache };
