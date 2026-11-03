const service = require('./reviews.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const reviews = await service.listReviews(req.businessId, { cleanerId: req.query.cleanerId });
    return success(res, 200, reviews);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const r = await service.createReview(req.businessId, req.body);
    return success(res, 201, r, 'Review created');
  } catch (err) {
    next(err);
  }
}

async function get(req, res, next) {
  try {
    const r = await service.getReview(req.businessId, req.params.id);
    return success(res, 200, r);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteReview(req.businessId, req.params.id);
    return success(res, 200, null, 'Review deleted');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, get, remove };
