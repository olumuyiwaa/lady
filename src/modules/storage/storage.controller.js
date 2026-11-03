const service = require('./storage.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const items = await service.listStorageItems(req.businessId);
    return success(res, 200, items);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const created = await service.createStorageItem(req.businessId, req.body);
    return success(res, 201, created, 'Storage item created');
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteStorageItem(req.businessId, req.params.id);
    return success(res, 200, null, 'Storage item deleted');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, remove };
