/**
 * Validation for object-storage keys and upload content types.
 *
 * Upload URLs are minted by the server under a per-tenant prefix, but the
 * follow-up "register this file" calls used to accept whatever `storageKey`
 * string the client sent. Anyone who knew (or learned) another tenant's key
 * could register it as their own document, download it through the signed-URL
 * endpoint, and - because deleting a document also deletes the object - delete
 * it. Every client-supplied key must now be checked against the prefix the
 * server would have minted for that caller.
 */

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'];
// Public-read assets are served from the CDN/bucket domain, so only formats a
// browser renders as an inert image. No SVG (script), no HTML, no octet-stream.
const PUBLIC_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const MAX_KEY_LENGTH = 512;

function unprocessable(message) {
  const err = new Error(message);
  err.status = 422;
  return err;
}

const prefixes = {
  cleanerDocs: (businessId, cleanerId) => `businesses/${businessId}/cleaners/${cleanerId}/docs/`,
  cleanerAvatar: (businessId, cleanerId) => `businesses/${businessId}/cleaners/${cleanerId}/avatar/`,
  branding: (businessId) => `businesses/${businessId}/branding/`,
  compliance: (businessId) => `businesses/${businessId}/compliance/`,
  messages: (businessId) => `businesses/${businessId}/messages/`,
  tenant: (businessId) => `businesses/${businessId}/`,
};

/** Throws 422 unless `key` is a clean string that starts with `prefix`. */
function assertKeyUnderPrefix(key, prefix, field = 'storageKey') {
  const ok =
    typeof key === 'string' &&
    key.length > prefix.length &&
    key.length <= MAX_KEY_LENGTH &&
    key.startsWith(prefix) &&
    !key.includes('..') &&
    !key.includes('//', prefix.length - 1) &&
    !key.includes('\\') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f]/.test(key);
  if (!ok) throw unprocessable(`${field} is not valid for this resource`);
  return key;
}

/** Boolean form, for defence-in-depth checks (e.g. before deleting an object). */
function isKeyUnderPrefix(key, prefix) {
  try {
    assertKeyUnderPrefix(key, prefix);
    return true;
  } catch {
    return false;
  }
}

/** Returns the normalised content type or throws 422. No default is assumed. */
function assertContentType(contentType, allowed) {
  const ct = typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
  if (!allowed.includes(ct)) throw unprocessable(`contentType must be one of ${allowed.join(', ')}`);
  return ct;
}

module.exports = {
  IMAGE_TYPES,
  DOCUMENT_TYPES,
  PUBLIC_IMAGE_TYPES,
  prefixes,
  assertKeyUnderPrefix,
  isKeyUnderPrefix,
  assertContentType,
};
