'use strict';

// See inventory.service.js's identical comment -- same fix, same reason.
const prisma = require('../../config/database');
const { getSignedUploadUrl } = require('../../config/storage');
const { DOCUMENT_TYPES, prefixes, assertKeyUnderPrefix, assertContentType } = require('../../lib/storageKeys');

class ComplianceService {
  // ─── Documents (SDS etc.) ────────────────────────────────

  async listDocuments(businessId, { type, expiringSoon } = {}) {
    const where = { businessId };
    if (type) where.type = type;
    if (expiringSoon) {
      const in30Days = new Date();
      in30Days.setDate(in30Days.getDate() + 30);
      where.expiresAt = { lte: in30Days, gte: new Date() };
    }

    return prisma.complianceDocument.findMany({
      where,
      orderBy: [{ type: 'asc' }, { title: 'asc' }],
    });
  }

  async getDocument(businessId, docId) {
    return prisma.complianceDocument.findFirst({
      where: { id: docId, businessId },
      include: {
        inventoryItems: { select: { id: true, name: true, sku: true } },
      },
    });
  }

  /** Presigned upload URL under this business's compliance prefix. */
  async getUploadUrl(businessId, { contentType, filename } = {}) {
    const type = assertContentType(contentType, DOCUMENT_TYPES);
    const safeName = (filename || 'document').replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${prefixes.compliance(businessId)}${Date.now()}-${safeName}`;
    const uploadUrl = await getSignedUploadUrl(key, type);
    return { uploadUrl, storageKey: key };
  }

  async createDocument(businessId, data, uploadedById) {
    assertKeyUnderPrefix(data.storageKey, prefixes.compliance(businessId));
    return prisma.complianceDocument.create({
      data: {
        ...data,
        businessId,
        uploadedById: uploadedById || null,
      },
    });
  }

  async updateDocument(businessId, docId, data) {
    const existing = await prisma.complianceDocument.findFirst({
      where: { id: docId, businessId },
    });
    if (!existing) throw Object.assign(new Error('Document not found'), { status: 404 });
    if (data.storageKey !== undefined) assertKeyUnderPrefix(data.storageKey, prefixes.compliance(businessId));

    return prisma.complianceDocument.update({
      where: { id: docId },
      data,
    });
  }

  async deleteDocument(businessId, docId) {
    const existing = await prisma.complianceDocument.findFirst({
      where: { id: docId, businessId },
    });
    if (!existing) throw Object.assign(new Error('Document not found'), { status: 404 });

    // Clear any inventory items that pointed to this SDS
    await prisma.inventoryItem.updateMany({
      where: { sdsId: docId },
      data: { sdsId: null },
    });

    return prisma.complianceDocument.delete({ where: { id: docId } });
  }

  // ─── Training acknowledgements ───────────────────────────

  async recordTrainingAck(businessId, { cleanerId, documentId, notes }) {
    // Ensure cleaner + document belong to this business
    const [cleaner, doc] = await Promise.all([
      prisma.cleanerProfile.findFirst({ where: { id: cleanerId, businessId } }),
      prisma.complianceDocument.findFirst({ where: { id: documentId, businessId } }),
    ]);
    if (!cleaner) throw Object.assign(new Error('Cleaner not found'), { status: 404 });
    if (!doc) throw Object.assign(new Error('Document not found'), { status: 404 });

    return prisma.chemicalTrainingAck.upsert({
      where: { cleanerId_documentId: { cleanerId, documentId } },
      create: {
        businessId,
        cleanerId,
        documentId,
        notes: notes || null,
      },
      update: {
        acknowledgedAt: new Date(),
        notes: notes || null,
      },
    });
  }

  async listTrainingAcks(businessId, { cleanerId, documentId } = {}) {
    const where = { businessId };
    if (cleanerId) where.cleanerId = cleanerId;
    if (documentId) where.documentId = documentId;

    return prisma.chemicalTrainingAck.findMany({
      where,
      include: {
        cleaner: {
          select: {
            id: true,
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
      },
      orderBy: { acknowledgedAt: 'desc' },
    });
  }

  // ─── Audits ──────────────────────────────────────────────

  async listAudits(businessId, { status } = {}) {
    const where = { businessId };
    if (status) where.status = status;

    return prisma.complianceAudit.findMany({
      where,
      orderBy: { conductedAt: 'desc' },
    });
  }

  async getAudit(businessId, auditId) {
    return prisma.complianceAudit.findFirst({
      where: { id: auditId, businessId },
    });
  }

  async createAudit(businessId, data) {
    return prisma.complianceAudit.create({
      data: { ...data, businessId },
    });
  }

  async updateAudit(businessId, auditId, data) {
    const existing = await prisma.complianceAudit.findFirst({
      where: { id: auditId, businessId },
    });
    if (!existing) throw Object.assign(new Error('Audit not found'), { status: 404 });

    return prisma.complianceAudit.update({
      where: { id: auditId },
      data,
    });
  }
}

module.exports = new ComplianceService();
