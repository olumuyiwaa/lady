const crypto = require('crypto');
const prisma = require('../../config/database');
const { pick } = require('../../utils/pick');

const COUPON_FIELDS = [
  'code', 'type', 'value', 'isActive', 'appliesToServiceId',
  'expiresAt', 'maxRedemptions', 'perCustomerLimit',
];

function unprocessable(message) {
  const err = new Error(message);
  err.status = 422;
  return err;
}

/**
 * Whitelists coupon fields and validates the ones that would otherwise let a
 * bad row through (a PERCENT coupon over 100 makes prices negative-adjacent,
 * a service id from another tenant leaks across the tenant boundary).
 */
async function sanitizeCoupon(businessId, payload, { partial }) {
  const data = pick(payload, COUPON_FIELDS);

  if ('type' in data) {
    data.type = String(data.type).toUpperCase();
    if (!['PERCENT', 'AMOUNT'].includes(data.type)) throw unprocessable('type must be PERCENT or AMOUNT');
  } else if (!partial) {
    throw unprocessable('type is required');
  }

  if ('value' in data) {
    if (!Number.isInteger(data.value) || data.value < 0) throw unprocessable('value must be a non-negative integer');
  } else if (!partial) {
    throw unprocessable('value is required');
  }
  if (data.type === 'PERCENT' && data.value > 100) throw unprocessable('A percent coupon cannot exceed 100');

  if ('code' in data) {
    data.code = String(data.code).trim();
    if (!data.code) throw unprocessable('code is required');
  } else if (!partial) {
    throw unprocessable('code is required');
  }

  if (data.appliesToServiceId) {
    const svc = await prisma.service.findFirst({ where: { id: data.appliesToServiceId, businessId }, select: { id: true } });
    if (!svc) throw unprocessable('appliesToServiceId does not belong to this business');
  }
  if ('expiresAt' in data && data.expiresAt) data.expiresAt = new Date(data.expiresAt);

  return data;
}

async function getPricing(businessId) {
  let p = await prisma.businessPricing.findUnique({ where: { businessId } });
  if (!p) {
    // return defaults shape — perSqftCents/perRoomCents null here means
    // "not set", which lib/pricing.js reads as "use the platform DEFAULTS"
    return { businessId, frequencyDiscounts: null, perSqftCents: null, perRoomCents: null };
  }
  return p;
}

async function updatePricing(businessId, payload) {
  const existing = await prisma.businessPricing.findUnique({ where: { businessId } });
  if (existing) {
    return prisma.businessPricing.update({ where: { businessId }, data: payload });
  }
  return prisma.businessPricing.create({ data: { businessId, ...payload } });
}

async function listCoupons(businessId) {
  return prisma.coupon.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } });
}

async function createCoupon(businessId, payload) {
  const data = await sanitizeCoupon(businessId, payload, { partial: false });
  return prisma.coupon.create({ data: { ...data, businessId } });
}

async function updateCoupon(businessId, id, payload) {
  const c = await prisma.coupon.findFirst({ where: { id, businessId } });
  if (!c) {
    const err = new Error('Coupon not found'); err.status = 404; throw err;
  }
  const data = await sanitizeCoupon(businessId, payload, { partial: true });
  return prisma.coupon.update({ where: { id }, data });
}

async function deleteCoupon(businessId, id) {
  const c = await prisma.coupon.findFirst({ where: { id, businessId } });
  if (!c) {
    const err = new Error('Coupon not found'); err.status = 404; throw err;
  }
  // soft-delete: deactivate
  return prisma.coupon.update({ where: { id }, data: { isActive: false } });
}

function generateGiftCardCode() {
  // Codes are checkable from the public widget without authentication, so
  // they must not be guessable: 10 chars from a 32-symbol alphabet (~50 bits)
  // drawn from a CSPRNG rather than Math.random().
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return `GC-${out}`;
}

async function listGiftCards(businessId) {
  return prisma.giftCard.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } });
}

/**
 * Business-issued gift card — usable immediately (purchasePaidAt is set to
 * now, since there's no Stripe checkout to wait on here; that's the online
 * "customer buys one through the widget" path, which is a separate,
 * not-yet-built flow — see the note in widget.service.js).
 */
async function issueGiftCard(businessId, {
  code,
  initialValueCents,
  recipientEmail,
  recipientName,
  message,
  expiresAt,
} = {}) {
  if (!initialValueCents || initialValueCents < 1) {
    const err = new Error('initialValueCents must be greater than 0'); err.status = 422; throw err;
  }
  const finalCode = (code || generateGiftCardCode()).toUpperCase();
  const existing = await prisma.giftCard.findUnique({ where: { businessId_code: { businessId, code: finalCode } } });
  if (existing) {
    const err = new Error('A gift card with this code already exists'); err.status = 409; throw err;
  }
  return prisma.giftCard.create({
    data: {
      businessId,
      code: finalCode,
      initialValueCents,
      balanceCents: initialValueCents,
      recipientEmail: recipientEmail || null,
      recipientName: recipientName || null,
      message: message || null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      purchasePaidAt: new Date(),
    },
  });
}

async function deactivateGiftCard(businessId, id) {
  const gc = await prisma.giftCard.findFirst({ where: { id, businessId } });
  if (!gc) {
    const err = new Error('Gift card not found'); err.status = 404; throw err;
  }
  return prisma.giftCard.update({ where: { id }, data: { isActive: false } });
}

module.exports = {
  getPricing,
  updatePricing,
  listCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  listGiftCards,
  issueGiftCard,
  deactivateGiftCard,
};
