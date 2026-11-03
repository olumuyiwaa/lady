'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('./compliance.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

// Same fix, same reason as inventory.routes.js — see the comment there.
// This router had zero auth/tenant-scoping middleware, so getBusinessId()
// always resolved to undefined and every compliance document (SDS sheets,
// audits, training records) was readable by anyone, unauthenticated,
// across every business on the platform.
router.use(authenticate, scopeToBusiness, requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'));

// ─── Documents (SDS, risk assessments, etc.) ──────────────
router.get('/documents', ctrl.listDocuments);
router.get('/documents/:id', ctrl.getDocument);
router.post('/documents/upload-url', ctrl.getUploadUrl);
router.post('/documents', ctrl.createDocument);
router.patch('/documents/:id', ctrl.updateDocument);
router.delete('/documents/:id', ctrl.deleteDocument);

// ─── Training acknowledgements ────────────────────────────
router.get('/training-acks', ctrl.listTrainingAcks);
router.post('/training-acks', ctrl.recordTrainingAck);

// ─── Audits / inspections ─────────────────────────────────
router.get('/audits', ctrl.listAudits);
router.get('/audits/:id', ctrl.getAudit);
router.post('/audits', ctrl.createAudit);
router.patch('/audits/:id', ctrl.updateAudit);

module.exports = router;
