const service = require('./dispatch.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const items = await service.listDispatchItems(req.businessId);
    return success(res, 200, items);
  } catch (err) {
    next(err);
  }
}

async function createAssignment(req, res, next) {
  try {
    const a = await service.createAssignment(req.businessId, req.body.bookingId, req.body.cleanerId, req.user.id, {
      isTeamLead: req.body.isTeamLead,
      earningsSplitPercent: req.body.earningsSplitPercent,
    });
    return success(res, 201, a, 'Assignment created');
  } catch (err) {
    next(err);
  }
}

async function getAssignment(req, res, next) {
  try {
    const a = await service.getAssignment(req.businessId, req.params.id);
    return success(res, 200, a);
  } catch (err) {
    next(err);
  }
}

async function removeAssignment(req, res, next) {
  try {
    await service.deleteAssignment(req.businessId, req.params.id);
    return success(res, 200, null, 'Assignment removed');
  } catch (err) {
    next(err);
  }
}

async function suggestCleaners(req, res, next) {
  try {
    const bookingId = req.query.bookingId || req.body && req.body.bookingId;
    const limit = parseInt(req.query.limit || req.body && req.body.limit || '5', 10);
    if (!bookingId) {
      const err = new Error('bookingId required');
      err.status = 422;
      throw err;
    }
    const list = await service.suggestCleaners(req.businessId, bookingId, limit);
    return success(res, 200, list);
  } catch (err) {
    next(err);
  }
}

async function getCleanerDayRoute(req, res, next) {
  try {
    const date = req.query.date;
    if (!date) {
      const err = new Error('date query param (YYYY-MM-DD) required');
      err.status = 422;
      throw err;
    }
    const route = await service.getCleanerDayRoute(req.businessId, req.params.cleanerId, date);
    return success(res, 200, route);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, createAssignment, getAssignment, removeAssignment, suggestCleaners, getCleanerDayRoute };