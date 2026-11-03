const prisma = require('../config/database');

async function audit({ businessId = null, actorUserId = null, action, entityType, entityId, metadata = null }) {
  await prisma.auditLog.create({
    data: { businessId, actorUserId, action, entityType, entityId, metadata },
  });
}

module.exports = { audit };
