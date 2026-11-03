const service = require('./payroll.service');
const { success } = require('../../utils/response');

async function listCompensations(req, res, next) {
  try {
    const comps = await service.listCompensations(req.businessId);
    return success(res, 200, comps);
  } catch (err) {
    next(err);
  }
}

async function setCompensation(req, res, next) {
  try {
    const comp = await service.setCompensation(req.businessId, req.user.id, req.params.cleanerId, req.body);
    return success(res, 200, comp, 'Compensation updated');
  } catch (err) {
    next(err);
  }
}

async function listEarnings(req, res, next) {
  try {
    const earnings = await service.listEarnings(req.businessId, { cleanerId: req.query.cleanerId, status: req.query.status });
    return success(res, 200, earnings);
  } catch (err) {
    next(err);
  }
}

async function getSummary(req, res, next) {
  try {
    const summary = await service.getBusinessPayrollSummary(req.businessId);
    return success(res, 200, summary);
  } catch (err) {
    next(err);
  }
}

async function myEarnings(req, res, next) {
  try {
    const summary = await service.getMyEarningsSummary(req.businessId, req.user.id, (req.cleaner && req.cleaner.id) || req.user.cleanerProfileId);
    return success(res, 200, summary);
  } catch (err) {
    next(err);
  }
}

async function listPayouts(req, res, next) {
  try {
    const payouts = await service.listPayouts(req.businessId, { cleanerId: req.query.cleanerId, status: req.query.status });
    return success(res, 200, payouts);
  } catch (err) {
    next(err);
  }
}

async function createPayout(req, res, next) {
  try {
    const payout = await service.createPayout(req.businessId, req.user.id, req.params.cleanerId, req.body || {});
    return success(res, 201, payout, 'Payout created');
  } catch (err) {
    next(err);
  }
}

async function markPayoutPaid(req, res, next) {
  try {
    const payout = await service.markPayoutPaid(req.businessId, req.user.id, req.params.id, req.body || {});
    return success(res, 200, payout, 'Payout marked as paid');
  } catch (err) {
    next(err);
  }
}

async function payViaStripe(req, res, next) {
  try {
    const payout = await service.payViaStripe(req.businessId, req.user.id, req.params.id);
    return success(res, 200, payout, 'Payout paid via Stripe');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listCompensations,
  setCompensation,
  listEarnings,
  getSummary,
  myEarnings,
  listPayouts,
  createPayout,
  markPayoutPaid,
  payViaStripe,
};
