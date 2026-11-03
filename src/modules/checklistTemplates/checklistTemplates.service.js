const prisma = require('../../config/database');
const { pick } = require('../../utils/pick');

const TEMPLATE_FIELDS = ['name', 'items'];

async function listTemplates(businessId) {
  return prisma.checklistTemplate.findMany({ where: { businessId }, orderBy: { createdAt: 'desc' } });
}

async function getTemplate(businessId, id) {
  const t = await prisma.checklistTemplate.findFirst({ where: { id, businessId } });
  if (!t) {
    const err = new Error('Template not found');
    err.status = 404;
    throw err;
  }
  return t;
}

async function createTemplate(businessId, payload) {
  const { name, items } = payload;
  const created = await prisma.checklistTemplate.create({ data: { businessId, name, items } });
  return created;
}

async function updateTemplate(businessId, id, patch) {
  const t = await getTemplate(businessId, id);
  const updated = await prisma.checklistTemplate.update({ where: { id: t.id }, data: pick(patch, TEMPLATE_FIELDS) });
  return updated;
}

async function deleteTemplate(businessId, id) {
  const t = await getTemplate(businessId, id);
  await prisma.checklistTemplate.delete({ where: { id: t.id } });
}

module.exports = { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate };
