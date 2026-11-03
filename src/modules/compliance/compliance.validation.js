'use strict';

const { z } = require('zod');

const complianceDocType = z.enum([
  'SDS',
  'RISK_ASSESSMENT',
  'COSHH_ASSESSMENT',
  'TRAINING_RECORD',
  'INSPECTION_REPORT',
  'CERTIFICATE',
  'OTHER',
]);

const createDocumentSchema = z.object({
  type: complianceDocType.default('SDS'),
  title: z.string().min(1).max(300),
  storageKey: z.string().min(1), // already uploaded to S3
  mimeType: z.string().max(100).optional().nullable(),
  fileSize: z.number().int().positive().optional().nullable(),
  version: z.string().max(80).optional().nullable(),
  effectiveAt: z.coerce.date().optional().nullable(),
  expiresAt: z.coerce.date().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

const updateDocumentSchema = createDocumentSchema.partial();

const trainingAckSchema = z.object({
  cleanerId: z.string().cuid(),
  documentId: z.string().cuid(),
  notes: z.string().max(500).optional().nullable(),
});

const createAuditSchema = z.object({
  title: z.string().min(1).max(300),
  type: z.string().min(1).max(80), // OSHA_INSPECTION | INTERNAL | CLIENT | SDS_REVIEW
  status: z.enum(['OPEN', 'IN_PROGRESS', 'CLOSED']).default('OPEN'),
  findings: z.any().optional().nullable(),
  score: z.number().int().min(0).max(100).optional().nullable(),
  conductedAt: z.coerce.date(),
  conductedBy: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

const updateAuditSchema = createAuditSchema.partial();

module.exports = {
  createDocumentSchema,
  updateDocumentSchema,
  trainingAckSchema,
  createAuditSchema,
  updateAuditSchema,
};
