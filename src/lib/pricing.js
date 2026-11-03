const prisma = require('../config/database');
const DEFAULTS = {
  perSqftCents: 10, // 10 cents per sqft
  perRoomCents: 1500, // $15 per room
  hourlyMultiplier: 1, // basePriceCents treated as hourly rate
  frequencyDiscounts: { WEEKLY: 0.10, BIWEEKLY: 0.05, MONTHLY: 0.0 },
};

function sumAddOnData(service, selectedAddOnIds = []) {
  if (!service || !service.addOns) return { addOnTotal: 0, extraMinutes: 0 };
  const selected = service.addOns.filter(a => selectedAddOnIds.includes(a.id));
  const addOnTotal = selected.reduce((s, a) => s + (a.priceCents || 0), 0);
  const extraMinutes = selected.reduce((s, a) => s + (a.extraMinutes || 0), 0);
  return { addOnTotal, extraMinutes };
}

// rates lets a caller override the platform-wide DEFAULTS with a specific
// business's BusinessPricing.perSqftCents/perRoomCents (see calculateQuote).
// Falls back to DEFAULTS when a business hasn't set its own rate, so this
// stays backwards-compatible for any caller that doesn't pass rates at all.
function calculateBase(service, { sqft, rooms, bathrooms, customDurationMinutes } = {}, rates = {}) {
  const model = service.pricingModel || 'FLAT';
  let base = service.basePriceCents || 0;
  let estimatedMinutes = service.estimatedMinutes || 60;

  if (model === 'PER_SQFT') {
    const per = rates.perSqftCents != null ? rates.perSqftCents : DEFAULTS.perSqftCents;
    base = Math.round((service.basePriceCents || 0) + (Number(sqft || 0) * per));
  } else if (model === 'PER_ROOM') {
    const per = rates.perRoomCents != null ? rates.perRoomCents : DEFAULTS.perRoomCents;
    base = Math.round((service.basePriceCents || 0) + (Number(rooms || 0) * per));
  } else if (model === 'HOURLY') {
    const hourly = service.basePriceCents || 0; // treat base as hourly rate
    const minutes = Number(customDurationMinutes || service.estimatedMinutes || 60);
    base = Math.round((hourly / 60) * minutes);
    estimatedMinutes = minutes;
  } else {
    // FLAT
    base = service.basePriceCents || 0;
  }

  return { base, estimatedMinutes };
}

function applyFrequencyDiscount(priceCents, frequency) {
  if (!frequency) return priceCents;
  const disc = DEFAULTS.frequencyDiscounts[frequency] || 0;
  return Math.round(priceCents * (1 - disc));
}

async function calculateQuote(service, payload = {}) {
  const { businessId, addOnIds = [], frequency, couponCode, giftCardCode } = payload;
  let couponInfo;
  let giftCardInfo;

  // Single BusinessPricing lookup, reused below for both the PER_SQFT/
  // PER_ROOM rate override and the frequency-discount override. Previously
  // this row was fetched a second time further down just for
  // frequencyDiscounts; folding it into one fetch here also means
  // calculateBase (which used to only ever see the hardcoded platform
  // DEFAULTS) now gets the business's own rate.
  let bp = null;
  if (businessId) {
    try {
      bp = await prisma.businessPricing.findUnique({ where: { businessId } });
    } catch (e) {
      // ignore DB errors and fall back to defaults below
    }
  }

  const rates = {
    perSqftCents: bp && bp.perSqftCents != null ? bp.perSqftCents : undefined,
    perRoomCents: bp && bp.perRoomCents != null ? bp.perRoomCents : undefined,
  };

  const { base, estimatedMinutes: baseMinutes } = calculateBase(service, payload, rates);
  const { addOnTotal, extraMinutes } = sumAddOnData(service, addOnIds);

  const estimatedMinutes = baseMinutes + extraMinutes;

  let total = Math.max(0, base + addOnTotal);

  // apply business-configured frequency discounts when available
  let freqDisc = DEFAULTS.frequencyDiscounts;
  if (bp && bp.frequencyDiscounts) {
    try {
      const parsed = typeof bp.frequencyDiscounts === 'string' ? JSON.parse(bp.frequencyDiscounts) : bp.frequencyDiscounts;
      freqDisc = Object.assign({}, DEFAULTS.frequencyDiscounts, parsed || {});
    } catch (e) {
      // malformed JSON on the row — fall back to defaults rather than throw
    }
  }

  if (frequency) {
    const disc = (freqDisc && freqDisc[frequency]) || 0;
    total = Math.round(total * (1 - disc));
  }

  // apply coupon if provided
  if (businessId && couponCode) {
    try {
      const coupon = await prisma.coupon.findFirst({ where: { businessId, code: couponCode, isActive: true } });
      if (!coupon) {
        couponInfo = { valid: false, reason: 'not_found' };
      } else if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
        couponInfo = { valid: false, reason: 'expired', couponId: coupon.id };
      } else if (coupon.appliesToServiceId && coupon.appliesToServiceId !== service.id) {
        couponInfo = { valid: false, reason: 'service_mismatch', couponId: coupon.id };
      } else if (coupon.maxRedemptions && (coupon.redeemedCount || 0) >= coupon.maxRedemptions) {
        couponInfo = { valid: false, reason: 'max_redemptions', couponId: coupon.id };
      } else {
        // coupon is currently valid (note: per-customer limits require customer context and are checked at booking time)
        couponInfo = { valid: true, couponId: coupon.id, type: coupon.type, value: coupon.value };
        const t = String(coupon.type || '').toUpperCase();
        if (t === 'PERCENT') {
          total = Math.round(total * (1 - (coupon.value || 0) / 100));
        } else if (t === 'AMOUNT') {
          total = Math.max(0, total - (coupon.value || 0));
        }
      }
    } catch (e) {
      // ignore coupon lookup failures
    }
  }

  // Preview a gift card's applicability without touching its balance —
  // actual redemption (the atomic decrement) happens at booking time in
  // widget.service.applyGiftCardToBooking, same preview/redeem split as
  // coupons above. appliedCents is capped at what's actually owed after
  // the coupon discount, so it's never shown as covering more than the job
  // costs.
  if (businessId && giftCardCode) {
    try {
      const giftCard = await prisma.giftCard.findFirst({
        where: { businessId, code: String(giftCardCode).toUpperCase(), isActive: true },
      });
      if (!giftCard) {
        giftCardInfo = { valid: false, reason: 'not_found' };
      } else if (!giftCard.purchasePaidAt) {
        giftCardInfo = { valid: false, reason: 'not_yet_active', giftCardId: giftCard.id };
      } else if (giftCard.expiresAt && new Date(giftCard.expiresAt) < new Date()) {
        giftCardInfo = { valid: false, reason: 'expired', giftCardId: giftCard.id };
      } else if (giftCard.balanceCents <= 0) {
        giftCardInfo = { valid: false, reason: 'zero_balance', giftCardId: giftCard.id };
      } else {
        giftCardInfo = {
          valid: true,
          giftCardId: giftCard.id,
          balanceCents: giftCard.balanceCents,
          appliedCents: Math.min(giftCard.balanceCents, total),
        };
      }
    } catch (e) {
      // ignore gift card lookup failures
    }
  }

  const breakdown = {
    base,
    addOnTotal,
    frequency: frequency || null,
    total,
    estimatedMinutes,
  };

  const result = { priceCents: total, breakdown };
  if (typeof couponInfo !== 'undefined') result.coupon = couponInfo;
  if (typeof giftCardInfo !== 'undefined') result.giftCard = giftCardInfo;
  return result;
}

/**
 * Returns the deposit amount (in cents) required at booking time for this
 * business, or 0 if the business hasn't configured a deposit policy.
 * Shared by the widget quote (so the customer sees it before booking) and
 * submitBooking (so the actual checkout session matches the quote).
 */
async function computeDepositCents(businessId, priceCents) {
  if (!businessId) return 0;
  const bp = await prisma.businessPricing.findUnique({ where: { businessId } });
  if (!bp || !bp.depositType) return 0;
  if (bp.depositType === 'PERCENT') {
    return Math.round((priceCents * (bp.depositValue || 0)) / 100);
  }
  if (bp.depositType === 'AMOUNT') {
    return Math.min(bp.depositValue || 0, priceCents);
  }
  return 0;
}

module.exports = { calculateQuote, computeDepositCents };
