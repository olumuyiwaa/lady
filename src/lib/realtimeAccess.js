const prisma = require('../config/database');

/**
 * Authorization for realtime rooms. Socket handshakes only prove a token was
 * valid at connect time, so every room a socket may join is decided here
 * against the database.
 *
 * - `business:{id}` carries every booking event for the tenant (addresses,
 *   access codes). It is for staff only. Cleaners previously joined it too and
 *   received every job in the business, not just their own.
 * - `conversation:{id}` is joinable by staff of the same business, or by the
 *   cleaner the conversation is with. Previously any authenticated socket
 *   could join any conversation id, in any tenant.
 */

async function resolveRealtimeRole(userId, businessId) {
  if (!businessId) return { isStaff: false, isCleaner: false };
  const [member, cleaner] = await Promise.all([
    prisma.businessMember.findFirst({ where: { businessId, userId, isActive: true }, select: { id: true } }),
    prisma.cleanerProfile.findFirst({ where: { businessId, userId, status: 'ACTIVE' }, select: { id: true } }),
  ]);
  return { isStaff: !!member, isCleaner: !!cleaner, cleanerProfileId: cleaner ? cleaner.id : null };
}

async function canJoinConversation(userId, businessId, conversationId) {
  if (!userId || !businessId || typeof conversationId !== 'string' || !conversationId) return false;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, businessId },
    select: { subjectType: true, subjectId: true },
  });
  if (!conversation) return false;

  const role = await resolveRealtimeRole(userId, businessId);
  if (role.isStaff) return true;
  return conversation.subjectType === 'CLEANER' && role.cleanerProfileId === conversation.subjectId;
}

module.exports = { resolveRealtimeRole, canJoinConversation };
