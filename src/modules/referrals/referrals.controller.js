const service = require('./referrals.service');
const { success } = require('../../utils/response');

const wrap = (fn, status = 200) => async (req, res, next) => {
  try {
    return success(res, status, await fn(req));
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getSettings: wrap((req) => service.getSettings(req.businessId)),
  updateSettings: wrap((req) => service.updateSettings(req.businessId, req.body, req.user?.id)),
  list: wrap(async (req) => service.listReferrals(req.businessId, req.query)),
  stats: wrap((req) => service.getStats(req.businessId)),
  forfeit: wrap((req) => service.forfeitPendingReward(req.businessId, req.params.bookingId, req.user?.id)),
  cancelReward: wrap((req) => service.cancelReward(req.businessId, req.params.couponId, req.user?.id)),
};
