/**
 * Referral programme: "give X, get Y".
 *
 * A new customer who books with a friend's code gets `discountCents` off that
 * first booking; the friend who shared the code gets a single-use coupon worth
 * `rewardCents` for their next booking. Each business sets its own amounts in
 * BusinessPricing (defaults below reproduce the original EUR 20 / EUR 20 / 90
 * days). Reading the settings never throws: on any failure the defaults apply.
 */
const prisma = require('../config/database');
const logger = require('../config/logger');

const REFERRAL_DISCOUNT_CENTS = 2000;
const REFERRAL_REWARD_CENTS = 2000;
const REFERRAL_REWARD_VALID_DAYS = 90;

const DEFAULTS = {
  enabled: true,
  discountCents: REFERRAL_DISCOUNT_CENTS,
  rewardCents: REFERRAL_REWARD_CENTS,
  rewardValidDays: REFERRAL_REWARD_VALID_DAYS,
  minBookingCents: 0,
};

/** Pure: BusinessPricing row (or null) -> settings. */
function resolveSettings(row) {
  if (!row) return { ...DEFAULTS };
  const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : d);
  return {
    enabled: row.referralEnabled !== false,
    discountCents: num(row.referralDiscountCents, DEFAULTS.discountCents),
    rewardCents: num(row.referralRewardCents, DEFAULTS.rewardCents),
    rewardValidDays: num(row.referralRewardValidDays, DEFAULTS.rewardValidDays),
    minBookingCents: num(row.referralMinBookingCents, DEFAULTS.minBookingCents),
  };
}

async function getReferralSettings(businessId, db = prisma) {
  try {
    const row = await db.businessPricing.findUnique({ where: { businessId } });
    return resolveSettings(row);
  } catch (e) {
    logger.warn('referral settings lookup failed; using defaults', { businessId, error: e.message });
    return { ...DEFAULTS };
  }
}

/** Digits only, last 9 (so +31 6 12345678, 0612345678 and 06-12345678 compare equal). */
function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : d;
}

/** Lower-cased email without a "+tag" and, for Gmail, without dots. */
function emailKey(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return '';
  let local = e.slice(0, at).split('+')[0];
  const domain = e.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
  return `${local}@${domain === 'googlemail.com' ? 'gmail.com' : domain}`;
}

function addressKey(a) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const line = norm(a.line1 || a.addressLine1);
  const postal = norm(a.postalCode).replace(/ /g, '');
  return line && postal ? `${postal}|${line}` : '';
}

/**
 * Pure: why this referral should not count, or null if it looks genuine.
 * referrer: { phone, email }, referrerAddresses: [{line1|addressLine1, postalCode}],
 * newcomer: { phone, email, addressLine1, postalCode }.
 * Returns 'SAME_PHONE' | 'SAME_EMAIL' | 'SAME_ADDRESS' | null.
 */
function detectSelfReferral(referrer, referrerAddresses, newcomer) {
  if (phoneKey(referrer.phone) && phoneKey(referrer.phone) === phoneKey(newcomer.phone)) return 'SAME_PHONE';
  if (emailKey(referrer.email) && emailKey(referrer.email) === emailKey(newcomer.email)) return 'SAME_EMAIL';
  const mine = addressKey({ addressLine1: newcomer.addressLine1, postalCode: newcomer.postalCode });
  if (mine && (referrerAddresses || []).some((a) => addressKey(a) === mine)) return 'SAME_ADDRESS';
  return null;
}

module.exports = {
  REFERRAL_DISCOUNT_CENTS,
  REFERRAL_REWARD_CENTS,
  REFERRAL_REWARD_VALID_DAYS,
  DEFAULTS,
  resolveSettings,
  getReferralSettings,
  detectSelfReferral,
  phoneKey,
  emailKey,
};
