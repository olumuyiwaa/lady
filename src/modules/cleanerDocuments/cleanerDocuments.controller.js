const service = require('./cleanerDocuments.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const docs = await service.listDocuments(req.businessId, {
      cleanerId: req.query.cleanerId,
      type: req.query.type,
    });
    return success(res, 200, docs);
  } catch (err) {
    next(err);
  }
}

async function get(req, res, next) {
  try {
    const doc = await service.getDocument(req.businessId, req.params.id);
    return success(res, 200, doc);
  } catch (err) {
    next(err);
  }
}

async function uploadUrl(req, res, next) {
  try {
    const result = await service.getUploadUrl(req.businessId, req.body);
    return success(res, 200, result);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const doc = await service.createDocument(req.businessId, req.user.id, req.body);
    return success(res, 201, doc, 'Document recorded');
  } catch (err) {
    next(err);
  }
}

async function downloadUrl(req, res, next) {
  try {
    const result = await service.getDownloadUrl(req.businessId, req.params.id);
    return success(res, 200, result);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteDocument(req.businessId, req.params.id, req.user.id);
    return success(res, 200, null, 'Document deleted');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, get, uploadUrl, create, downloadUrl, remove };
