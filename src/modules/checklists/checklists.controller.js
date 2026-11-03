const service = require('./checklists.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const checklists = await service.listChecklists(req.businessId, req.user);
    return success(res, 200, checklists);
  } catch (err) {
    next(err);
  }
}

async function get(req, res, next) {
  try {
    const c = await service.getChecklist(req.businessId, req.params.bookingId, req.user);
    return success(res, 200, c);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const created = await service.createChecklist(req.businessId, req.body.bookingId, req.body.items, req.user);
    return success(res, 201, created, 'Checklist created');
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const updated = await service.updateChecklist(req.businessId, req.params.bookingId, req.body.items, req.user);
    return success(res, 200, updated, 'Checklist updated');
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteChecklist(req.businessId, req.params.bookingId, req.user);
    return success(res, 200, null, 'Checklist deleted');
  } catch (err) {
    next(err);
  }
}

async function completeItem(req, res, next) {
  try {
    const result = await service.completeChecklistItem(
      req.businessId,
      req.params.bookingId,
      req.params.itemId,
      req.body?.done,
      req.user
    );
    return success(res, 200, result, 'Checklist item updated');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, get, create, update, remove, completeItem };
