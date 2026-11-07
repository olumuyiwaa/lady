/**
 * The facts the assistant may use: services and prices, add-ons, discounts, areas,
 * opening hours, the cancellation policy, referral offer and the business's own FAQ.
 * Read from the database (so it follows the dashboard) and kept for a few minutes.
 * Prices are VAT-inclusive, as everywhere else in the product.
 */
const prisma = require('../../config/database');

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const eur = (cents, cur = 'eur') => new Intl.NumberFormat('en-GB', { style: 'currency', currency: String(cur).toUpperCase() }).format((cents || 0) / 100);
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function priceLine(svc, pricing, cur) {
  const unit = pricing?.sizeUnit === 'SQFT' ? 'sq ft' : 'm²';
  switch (svc.pricingModel) {
    case 'PER_SQFT': return `${eur(pricing?.perSqftCents ?? svc.basePriceCents, cur)} per ${unit}`;
    case 'PER_ROOM': return `${eur(pricing?.perRoomCents ?? svc.basePriceCents, cur)} per room`;
    case 'HOURLY': return `${eur(svc.basePriceCents, cur)} per hour`;
    default: return `${eur(svc.basePriceCents, cur)} flat`;
  }
}

function policyText(pricing, cur) {
  if (!pricing || pricing.cancellationWindowHours == null) return 'Free cancellation at any time.';
  const fee = pricing.cancellationFeeType === 'PERCENT' ? `${pricing.cancellationFeeValue}% of the price` : eur(pricing.cancellationFeeValue, cur);
  return `Free cancellation until ${pricing.cancellationWindowHours} hours before the visit; later cancellations cost ${fee}.`;
}

async function build(businessId) {
  const [business, services, areas, hours, pricing, branding] = await Promise.all([
    prisma.business.findUnique({ where: { id: businessId }, select: { name: true, currency: true, contactPhone: true, timezone: true } }),
    prisma.service.findMany({ where: { businessId, isActive: true }, include: { addOns: true }, orderBy: { createdAt: 'asc' }, take: 40 }),
    prisma.serviceArea.findMany({ where: { businessId }, select: { name: true }, take: 40 }),
    prisma.businessHours.findMany({ where: { businessId }, orderBy: { dayOfWeek: 'asc' } }),
    prisma.businessPricing.findUnique({ where: { businessId } }),
    prisma.businessBranding.findUnique({ where: { businessId }, select: { tagline: true, aboutBody: true, faqItems: true } }),
  ]);
  const cur = business?.currency || 'eur';
  const lines = [];
  lines.push(`BUSINESS: ${business?.name || 'Tod Cleaning Services'} (cleaning company in the Netherlands)`);
  if (branding?.tagline) lines.push(`Tagline: ${clip(branding.tagline, 200)}`);
  if (branding?.aboutBody) lines.push(`About: ${clip(branding.aboutBody, 600)}`);
  if (business?.contactPhone) lines.push(`Phone: ${business.contactPhone}`);

  lines.push('\nSERVICES (prices include VAT):');
  for (const s of services) {
    lines.push(`- ${s.name}: ${priceLine(s, pricing, cur)}, about ${s.estimatedMinutes} minutes.${s.description ? ` ${clip(s.description, 300)}` : ''}`);
    for (const a of s.addOns || []) lines.push(`    add-on "${a.name}": ${eur(a.priceCents, cur)}${a.extraMinutes ? ` (+${a.extraMinutes} min)` : ''}`);
  }

  const fd = pricing?.frequencyDiscounts || { WEEKLY: 0.1, BIWEEKLY: 0.05 };
  const disc = Object.entries(fd).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k.toLowerCase()} ${Math.round(Number(v) * 100)}%`);
  if (disc.length) lines.push(`\nRECURRING DISCOUNTS: ${disc.join(', ')}.`);
  if (pricing?.travelFeePerKmCents) lines.push(`TRAVEL FEE: first ${pricing.travelFreeKm || 0} km free, then ${eur(pricing.travelFeePerKmCents, cur)} per km${pricing.travelFeeMaxCents ? `, at most ${eur(pricing.travelFeeMaxCents, cur)}` : ''}.`);
  if (pricing?.referralEnabled) lines.push(`REFERRALS: a friend gets ${eur(pricing.referralDiscountCents, cur)} off a first booking and the referrer gets ${eur(pricing.referralRewardCents, cur)} after that visit ("Give ${eur(pricing.referralDiscountCents, cur)}, get ${eur(pricing.referralRewardCents, cur)}").`);
  lines.push(`CANCELLATION: ${policyText(pricing, cur)}`);

  if (areas.length) lines.push(`\nSERVICE AREAS: ${areas.map((a) => a.name).join(', ')}. For an exact address, the postcode checker on the site gives the definite answer.`);
  if (hours.length) lines.push(`OPENING HOURS: ${hours.map((h) => `${DAYS[h.dayOfWeek]} ${h.isClosed ? 'closed' : `${h.openTime}-${h.closeTime}`}`).join('; ')}.`);

  const faq = Array.isArray(branding?.faqItems) ? branding.faqItems.filter((f) => f && f.question && f.answer).slice(0, 30) : [];
  if (faq.length) {
    lines.push('\nFAQ:');
    for (const f of faq) lines.push(`Q: ${clip(f.question, 200)}\nA: ${clip(f.answer, 500)}`);
  }
  return lines.join('\n');
}

async function getContext(businessId) {
  const hit = cache.get(businessId);
  if (hit && hit.expires > Date.now()) return hit.text;
  const text = await build(businessId);
  cache.set(businessId, { text, expires: Date.now() + TTL_MS });
  return text;
}

module.exports = { getContext, build, _cache: cache };
