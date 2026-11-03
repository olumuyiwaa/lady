const { getPublicUrl } = require('../config/storage');

/**
 * Resolves stored S3 keys on a BusinessBranding row into permanent public
 * URLs for anything actually rendered as an <img> — the dashboard's own
 * edit form and the public site/widget both need this, so it lives here
 * rather than duplicated in businesses.service and widget.service.
 *
 * Raw *Key fields are left in the returned object alongside the resolved
 * *Url ones: the dashboard needs the key (to know an image is already set
 * without re-uploading), the public site only ever reads the *Url fields.
 */
function toPublicBranding(branding) {
  if (!branding) return branding;
  return {
    ...branding,
    logoUrl: getPublicUrl(branding.logoKey),
    heroImageUrl: getPublicUrl(branding.heroImageKey),
    galleryImageUrls: (branding.galleryImageKeys || []).map((k) => getPublicUrl(k)),
  };
}

module.exports = { toPublicBranding };
