const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../../config/database');
const { audit } = require('../../utils/audit');
const notifications = require('../notifications/notifications.service');

/**
 * Invites a teammate (BUSINESS_MANAGER, or ORG_ADMIN on a parent/franchise
 * business) into a business. Mirrors cleaners.service.onboardCleaner's
 * find-or-create-user + invite-link pattern, since this is the same shape
 * of problem: a person may or may not already have a Tod Cleaning Services account.
 *
 * Until this existed, the only BusinessMember ever created was the owner
 * row registerBusiness makes at signup — there was no way for an owner to
 * add a second person to their own team.
 */
async function inviteMember(businessId, actorUserId, { firstName, lastName, email, phone, role }) {
  const allowedRoles = ['BUSINESS_MANAGER', 'ORG_ADMIN'];
  if (!allowedRoles.includes(role)) {
    const err = new Error(`role must be one of ${allowedRoles.join(', ')}`);
    err.status = 422;
    throw err;
  }

  // ORG_ADMIN only makes sense on a parent/franchise business — granting it
  // on a plain single-location business would create a role nothing checks
  // for correctly (scopeToBusiness treats ORG_ADMIN as "has locations to
  // switch between").
  if (role === 'ORG_ADMIN') {
    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { locations: { select: { id: true }, take: 1 } } });
    if (!business || business.locations.length === 0) {
      const err = new Error('ORG_ADMIN can only be granted on a business that has locations (a franchise parent)');
      err.status = 422;
      throw err;
    }
  }

  let user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    // Unusable password hash — the account can only be unlocked via the
    // real invite link (PasswordReset token) sendInvite emails/texts them.
    const unusablePassword = crypto.randomBytes(32).toString('hex');
    user = await prisma.user.create({
      data: {
        email,
        phone,
        firstName,
        lastName,
        passwordHash: await bcrypt.hash(unusablePassword, 12),
      },
    });
    try {
      await notifications.sendInvite(businessId, user.id, { email, phone });
    } catch (e) {
      // non-fatal — the member row still exists; they can always be re-invited
    }
  }

  const existing = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId, userId: user.id } },
  });
  if (existing && existing.isActive) {
    const err = new Error('This person is already an active member of this business');
    err.status = 409;
    throw err;
  }

  const member = existing
      ? await prisma.businessMember.update({
        where: { id: existing.id },
        data: {
          role,
          isActive: true,
          invitedByUserId: actorUserId,
          invitedAt: new Date(),
          joinedAt: null,
          removedAt: null,
        },
      })
      : await prisma.businessMember.create({
        data: { businessId, userId: user.id, role, invitedByUserId: actorUserId },
      });

  await audit({
    businessId,
    actorUserId,
    action: existing ? 'STAFF_REINVITED' : 'STAFF_INVITED',
    entityType: 'BusinessMember',
    entityId: member.id,
    metadata: { role, email },
  });

  return member;
}

async function listMembers(businessId) {
  return prisma.businessMember.findMany({
    where: { businessId },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
    orderBy: [{ isActive: 'desc' }, { invitedAt: 'desc' }],
  });
}

async function updateMemberRole(businessId, actorUserId, memberId, role) {
  const allowedRoles = ['BUSINESS_MANAGER', 'ORG_ADMIN'];
  if (!allowedRoles.includes(role)) {
    const err = new Error(`role must be one of ${allowedRoles.join(', ')}`);
    err.status = 422;
    throw err;
  }
  const member = await prisma.businessMember.findFirst({ where: { id: memberId, businessId } });
  if (!member) {
    const err = new Error('Member not found for this business');
    err.status = 404;
    throw err;
  }
  if (member.role === 'BUSINESS_OWNER') {
    const err = new Error("The business owner's role can't be changed here");
    err.status = 403;
    throw err;
  }

  const updated = await prisma.businessMember.update({ where: { id: memberId }, data: { role } });
  await audit({
    businessId,
    actorUserId,
    action: 'STAFF_ROLE_UPDATED',
    entityType: 'BusinessMember',
    entityId: memberId,
    metadata: { role },
  });
  return updated;
}

/**
 * Removes a teammate. Deactivates the membership rather than deleting the
 * row — same "keep history, revoke access" pattern as
 * cleaners.service.offboardCleaner — so past audit-log entries attributed
 * to them still resolve to a real BusinessMember.
 */
async function removeMember(businessId, actorUserId, memberId) {
  const member = await prisma.businessMember.findFirst({ where: { id: memberId, businessId } });
  if (!member) {
    const err = new Error('Member not found for this business');
    err.status = 404;
    throw err;
  }
  if (member.role === 'BUSINESS_OWNER') {
    const err = new Error('The business owner cannot be removed');
    err.status = 403;
    throw err;
  }
  if (member.userId === actorUserId) {
    const err = new Error("You can't remove yourself");
    err.status = 403;
    throw err;
  }

  const updated = await prisma.businessMember.update({
    where: { id: memberId },
    data: { isActive: false, removedAt: new Date() },
  });

  // Every active session in this workspace stops working immediately —
  // authenticate() re-checks isActive on every request, so this alone is
  // enough, but dropping sessions too means a refresh can't quietly revive
  // the workspace context either.
  await prisma.session.deleteMany({ where: { userId: member.userId, businessId } });

  await audit({
    businessId,
    actorUserId,
    action: 'STAFF_REMOVED',
    entityType: 'BusinessMember',
    entityId: memberId,
  });

  return updated;
}

module.exports = { inviteMember, listMembers, updateMemberRole, removeMember };
