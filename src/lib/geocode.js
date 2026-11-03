const logger = require('../config/logger');

const PDOK_URL = process.env.PDOK_LOCATIESERVER_URL || 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free';
const TIMEOUT_MS = 2500;

/**
 * Resolves a Dutch address to coordinates using PDOK's Locatieserver (the
 * Dutch government's free geocoder, no API key). Used when the booking form
 * did not supply coordinates, so the service-area check cannot be skipped
 * just by leaving latitude/longitude out of the request.
 *
 * Returns { latitude, longitude } or null. Never throws: a geocoder outage
 * must not block bookings, so callers treat null as "could not verify".
 */
async function geocodeNl({ postalCode, addressLine1, city } = {}) {
  const q = [addressLine1, postalCode, city].filter(Boolean).join(' ').trim();
  if (!q || !postalCode) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${PDOK_URL}?q=${encodeURIComponent(q)}&rows=1&fq=type:adres&fl=centroide_ll`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const wkt = json && json.response && json.response.docs && json.response.docs[0] && json.response.docs[0].centroide_ll;
    const m = typeof wkt === 'string' ? wkt.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/) : null;
    if (!m) return null;
    return { longitude: Number(m[1]), latitude: Number(m[2]) };
  } catch (e) {
    logger.warn('geocode failed', { error: e.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const POSTCODE_RE = /^[1-9]\d{3}\s?[A-Za-z]{2}$/;

/**
 * Postcode + house number -> street, city and coordinates (the standard Dutch
 * address lookup). Powers the booking form's autofill. Done server-side so the
 * visitor's browser never talks to a third party, and so the response is
 * limited to the few fields the form needs.
 *
 * Returns { street, houseNumber, city, postalCode, latitude, longitude } or
 * null. Never throws.
 */
async function lookupNlAddress({ postalCode, houseNumber } = {}) {
  const pc = String(postalCode || '').trim();
  const nr = String(houseNumber || '').trim();
  if (!POSTCODE_RE.test(pc) || !/^\d{1,5}\s?[A-Za-z]?([-\s]?[A-Za-z0-9]{1,4})?$/.test(nr)) return null;
  const normalized = pc.replace(/\s/g, '').toUpperCase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const q = `${normalized} ${nr}`;
    const url =
      `${PDOK_URL}?q=${encodeURIComponent(q)}&rows=1&fq=type:adres` +
      '&fl=straatnaam,woonplaatsnaam,postcode,huisnummer,huis_nlt,centroide_ll';
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const doc = json && json.response && json.response.docs && json.response.docs[0];
    if (!doc || !doc.straatnaam || !doc.woonplaatsnaam) return null;
    // The search is fuzzy: refuse a hit for a different postcode than asked.
    if (doc.postcode && String(doc.postcode).toUpperCase() !== normalized) return null;
    const m = typeof doc.centroide_ll === 'string' ? doc.centroide_ll.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/) : null;
    return {
      street: doc.straatnaam,
      houseNumber: doc.huis_nlt || String(doc.huisnummer || nr),
      city: doc.woonplaatsnaam,
      postalCode: `${normalized.slice(0, 4)} ${normalized.slice(4)}`,
      latitude: m ? Number(m[2]) : null,
      longitude: m ? Number(m[1]) : null,
    };
  } catch (e) {
    logger.warn('address lookup failed', { error: e.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { geocodeNl, lookupNlAddress };
