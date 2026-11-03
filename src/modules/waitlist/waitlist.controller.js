const service = require('./waitlist.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const rows = await service.listWaitlist(req.businessId, req.query);
    return success(res, 200, rows);
  } catch (err) {
    next(err);
  }
}

async function cancel(req, res, next) {
  try {
    const updated = await service.cancelWaitlistEntry(req.businessId, req.params.id);
    return success(res, 200, updated, 'Waitlist entry cancelled');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, cancel };
