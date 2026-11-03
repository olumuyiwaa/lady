const service = require('./bookingQuestions.service');
const { success } = require('../../utils/response');

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

const list = wrap(async (req, res) => success(res, 200, { questions: await service.list(req.businessId) }));
const create = wrap(async (req, res) => success(res, 201, await service.create(req.businessId, req.body || {})));
const update = wrap(async (req, res) => success(res, 200, await service.update(req.businessId, req.params.id, req.body || {})));
const remove = wrap(async (req, res) => {
  await service.remove(req.businessId, req.params.id);
  return success(res, 200, null, 'Question deleted');
});

module.exports = { list, create, update, remove };
