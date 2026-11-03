const service = require('./pricing.service');
const { success } = require('../../utils/response');

async function getPricing(req, res, next) {
  try {
    const p = await service.getPricing(req.businessId);
    return success(res, 200, p);
  } catch (e) {
    next(e);
  }
}

async function updatePricing(req, res, next) {
  try {
    // Whitelisted explicitly (rather than passing req.body straight
    // through) so this endpoint can't be used to write arbitrary columns
    // onto BusinessPricing. Undefined fields are dropped by Prisma's
    // update, not written as null, so a partial payload only touches the
    // keys the caller actually sent.
    const fields = [
      'frequencyDiscounts',
      'perSqftCents',
      'perRoomCents',
      'depositType',
      'depositValue',
      'cancellationWindowHours',
      'cancellationFeeType',
      'cancellationFeeValue',
    ];
    const payload = {};
    for (const f of fields) {
      if (req.body[f] !== undefined) payload[f] = req.body[f];
    }
    const updated = await service.updatePricing(req.businessId, payload);
    return success(res, 200, updated, 'Pricing updated');
  } catch (e) {
    next(e);
  }
}

async function listCoupons(req, res, next) {
  try {
    const rows = await service.listCoupons(req.businessId);
    return success(res, 200, rows);
  } catch (e) {
    next(e);
  }
}

async function createCoupon(req, res, next) {
  try {
    const created = await service.createCoupon(req.businessId, req.body);
    return success(res, 201, created, 'Coupon created');
  } catch (e) {
    next(e);
  }
}

async function updateCoupon(req, res, next) {
  try {
    const updated = await service.updateCoupon(req.businessId, req.params.id, req.body);
    return success(res, 200, updated, 'Coupon updated');
  } catch (e) {
    next(e);
  }
}

async function deleteCoupon(req, res, next) {
  try {
    const updated = await service.deleteCoupon(req.businessId, req.params.id);
    return success(res, 200, updated, 'Coupon deactivated');
  } catch (e) {
    next(e);
  }
}

async function listGiftCards(req, res, next) {
  try {
    const rows = await service.listGiftCards(req.businessId);
    return success(res, 200, rows);
  } catch (e) {
    next(e);
  }
}

async function issueGiftCard(req, res, next) {
  try {
    const created = await service.issueGiftCard(req.businessId, req.body);
    return success(res, 201, created, 'Gift card issued');
  } catch (e) {
    next(e);
  }
}

async function deactivateGiftCard(req, res, next) {
  try {
    const updated = await service.deactivateGiftCard(req.businessId, req.params.id);
    return success(res, 200, updated, 'Gift card deactivated');
  } catch (e) {
    next(e);
  }
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