const service = require('./leave.service');
const { success } = require('../../utils/response');

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

// Manager side (/leave)
const list = wrap(async (req, res) => success(res, 200, await service.list(req.businessId, req.query)));
const record = wrap(async (req, res) => {
  const { cleanerId, type, startDate, endDate, reason } = req.body;
  const out = await service.create({ businessId: req.businessId, cleanerId, type, startDate, endDate, reason, createdById: req.user.id, autoApprove: true });
  return success(res, 201, out, 'Leave recorded');
});
const approve = wrap(async (req, res) => success(res, 200, await service.approve(req.businessId, req.params.id, req.user.id, req.body.note), 'Leave approved'));
const reject = wrap(async (req, res) => success(res, 200, await service.reject(req.businessId, req.params.id, req.user.id, req.body.note), 'Leave rejected'));
const cancel = wrap(async (req, res) => success(res, 200, await service.cancel(req.businessId, req.params.id, { actorUserId: req.user.id }), 'Leave cancelled'));

// Cleaner side (/cleaners/me/leave)
const myList = wrap(async (req, res) => success(res, 200, await service.listForCleaner(req.cleaner.id)));
const myRequest = wrap(async (req, res) => {
  const { type, startDate, endDate, reason } = req.body;
  const out = await service.create({ businessId: req.businessId, cleanerId: req.cleaner.id, type, startDate, endDate, reason, createdById: req.user.id });
  return success(res, 201, out.leave, 'Leave requested');
});
const myCancel = wrap(async (req, res) => success(res, 200, await service.cancel(req.businessId, req.params.id, { actorUserId: req.user.id, cleanerId: req.cleaner.id }), 'Leave cancelled'));

module.exports = { list, record, approve, reject, cancel, myList, myRequest, myCancel };
