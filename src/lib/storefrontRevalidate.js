const prisma = require('../config/database');
const logger = require('../config/logger');

/**
 * Tells the frontend to drop its cached copy of a business's public storefront.
 *
 * The frontend caches each storefront for 5 minutes (Next.js data cache, tag
 * `storefront:{slug}`). Call this after anything the public site shows changes:
 * branding, services and add-ons, hours, the legal address, name, custom domain.
 *
 * Fire-and-forget by design: it never throws and callers must not await it, so a
 * frontend outage can never fail or slow down a dashboard save. Worst case the
 * public site refreshes on its normal 5-minute timer.
 *
 * Needs REVALIDATE_SECRET (same value as the frontend's) and a frontend base URL
 * in STOREFRONT_REVALIDATE_URL or FRONTEND_URL. Missing config is a silent no-op
 * so local development works without it.
 */
async function revalidateStorefront(businessId, extraSlugs = []) {
  try {
    const secret = process.env.REVALIDATE_SECRET;
    const base = (process.env.STOREFRONT_REVALIDATE_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
    if (!secret || !base) return;

    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { subdomain: true } });
    const slugs = [...new Set([business && business.subdomain, ...extraSlugs].filter(Boolean))];
    if (slugs.length === 0) return;

    const res = await fetch(`${base}/api/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-revalidate-secret': secret },
      body: JSON.stringify({ slugs }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) logger.warn('storefront revalidation rejected', { status: res.status, slugs });
  } catch (err) {
    logger.warn('storefront revalidation failed', { message: err && err.message });
  }
}

module.exports = { revalidateStorefront };
