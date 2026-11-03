'use strict';

const complianceService = require('./compliance.service');
const { success, error } = require('../../utils/response');
const {
  createDocumentSchema,
  updateDocumentSchema,
  trainingAckSchema,
  createAuditSchema,
  updateAuditSchema,
} = require('./compliance.validation');

// See inventory.controller.js's identical comment -- this used to read
// req.business?.id / req.user?.businessId, neither of which anything set
// on this router, so it always resolved to undefined.
function getBusinessId(req) {
  return req.businessId;
}

// ─── Documents ────────────────────────────────────────────

async function listDocuments(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const docs = await complianceService.listDocuments(businessId, {
      type: req.query.type,
      expiringSoon: req.query.expiringSoon === 'true',
    });
    return success(res, 200, docs);
  } catch (err) {
    next(err);
  }
}

async function getDocument(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const doc = await complianceService.getDocument(businessId, req.params.id);
    if (!doc) return error(res, 404, 'Document not found');
    return success(res, 200, doc);
  } catch (err) {
    next(err);
  }
}

async function getUploadUrl(req, res, next) {
  try {
    const { contentType, filename } = req.body || {};
    const result = await complianceService.getUploadUrl(getBusinessId(req), { contentType, filename });
    return success(res, 200, result);
  } catch (err) {
    next(err);
  }
}

async function createDocument(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = createDocumentSchema.parse(req.body);
    const doc = await complianceService.createDocument(businessId, data, req.user?.id);
    return success(res, 201, doc);
  } catch (err) {
    next(err);
  }
}

async function updateDocument(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = updateDocumentSchema.parse(req.body);
    const doc = await complianceService.updateDocument(businessId, req.params.id, data);
    return success(res, 200, doc);
  } catch (err) {
    next(err);
  }
}

async function deleteDocument(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    await complianceService.deleteDocument(businessId, req.params.id);
    return success(res, 200, null, 'Document deleted');
  } catch (err) {
    next(err);
  }
}

// ─── Training ─────────────────────────────────────────────

async function recordTrainingAck(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = trainingAckSchema.parse(req.body);
    const ack = await complianceService.recordTrainingAck(businessId, data);
    return success(res, 201, ack);
  } catch (err) {
    next(err);
  }
}

async function listTrainingAcks(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const acks = await complianceService.listTrainingAcks(businessId, {
      cleanerId: req.query.cleanerId,
      documentId: req.query.documentId,
    });
    return success(res, 200, acks);
  } catch (err) {
    next(err);
  }
}

// ─── Audits ───────────────────────────────────────────────

async function listAudits(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const audits = await complianceService.listAudits(businessId, {
      status: req.query.status,
    });
    return success(res, 200, audits);
  } catch (err) {
    next(err);
  }
}

async function getAudit(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const audit = await complianceService.getAudit(businessId, req.params.id);
    if (!audit) return error(res, 404, 'Audit not found');
    return success(res, 200, audit);
  } catch (err) {
    next(err);
  }
}

async function createAudit(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = createAuditSchema.parse(req.body);
    const audit = await complianceService.createAudit(businessId, data);
    return success(res, 201, audit);
  } catch (err) {
    next(err);
  }
}

async function updateAudit(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = updateAuditSchema.parse(req.body);
    const audit = await complianceService.updateAudit(businessId, req.params.id, data);
    return success(res, 200, audit);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listDocuments,
  getDocument,
  getUploadUrl,
  createDocument,
  updateDocument,
  deleteDocument,
  recordTrainingAck,
  listTrainingAcks,
  listAudits,
  getAudit,
  createAudit,
  updateAudit,
};
