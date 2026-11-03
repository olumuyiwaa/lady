const service = require('./checklistTemplates.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const items = await service.listTemplates(req.businessId);
    return success(res, 200, items);
  } catch (err) {
    next(err);
  }
}

async function get(req, res, next) {
  try {
    const t = await service.getTemplate(req.businessId, req.params.id);
    return success(res, 200, t);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const created = await service.createTemplate(req.businessId, req.body);
    return success(res, 201, created, 'Template created');
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const updated = await service.updateTemplate(req.businessId, req.params.id, req.body);
    return success(res, 200, updated, 'Template updated');
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteTemplate(req.businessId, req.params.id);
    return success(res, 200, null, 'Template deleted');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, get, create, update, remove };
