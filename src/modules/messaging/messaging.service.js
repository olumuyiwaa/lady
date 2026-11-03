const prisma = require('../../config/database');
const { prefixes, assertKeyUnderPrefix } = require('../../lib/storageKeys');

async function resolveSubjectLabel(subjectType, subjectId) {
  if (subjectType === 'CLEANER') {
    const c = await prisma.cleanerProfile.findUnique({
      where: { id: subjectId },
      include: { user: true },
    });
    if (!c) return null;
    return {
      id: c.id,
      type: 'CLEANER',
      name: `${c.user.firstName} ${c.user.lastName}`.trim(),
      email: c.user.email,
      status: c.status,
      userId: c.userId,
    };
  }
  if (subjectType === 'CUSTOMER') {
    const c = await prisma.customer.findUnique({ where: { id: subjectId } });
    if (!c) return null;
    return {
      id: c.id,
      type: 'CUSTOMER',
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email,
      phone: c.phone,
    };
  }
  return null;
}

/**
 * `requester` (optional) is the authenticate() result: { businessRole, cleanerProfileId }.
 * A CLEANER requester is restricted to their own CLEANER<->business thread —
 * cleaners must never see other cleaners' or customers' conversations.
 * Staff/owner/manager/SUPER_ADMIN are unaffected.
 */
function cleanerConversationFilter(requester) {
  if (requester?.businessRole !== 'CLEANER') return {};
  return { subjectType: 'CLEANER', subjectId: requester.cleanerProfileId };
}

/** True unless requester is a cleaner and this conversation isn't their own thread. */
function conversationBelongsToRequester(conv, requester) {
  if (requester?.businessRole !== 'CLEANER') return true;
  return conv.subjectType === 'CLEANER' && conv.subjectId === requester.cleanerProfileId;
}

async function listConversations(businessId, { page = 1, limit = 20 } = {}, requester = null) {
  const take = Math.min(Number(limit) || 20, 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
  const scope = cleanerConversationFilter(requester);

  const [total, rows] = await Promise.all([
    prisma.conversation.count({ where: { businessId, ...scope } }),
    prisma.conversation.findMany({
      where: { businessId, ...scope },
      include: {
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
  ]);

  const data = await Promise.all(
    rows.map(async (c) => {
      const subject = await resolveSubjectLabel(c.subjectType, c.subjectId);
      const last = c.messages[0] || null;
      return {
        id: c.id,
        businessId: c.businessId,
        subjectType: c.subjectType,
        subjectId: c.subjectId,
        subject,
        createdAt: c.createdAt,
        lastMessage: last
          ? {
              id: last.id,
              body: last.body,
              attachmentKey: last.attachmentKey,
              senderUserId: last.senderUserId,
              createdAt: last.createdAt,
              readAt: last.readAt,
            }
          : null,
        lastMessageAt: last?.createdAt || c.createdAt,
      };
    })
  );

  // Sort by last activity
  data.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

  return {
    data,
    pagination: {
      page: Number(page) || 1,
      limit: take,
      total,
      totalPages: Math.ceil(total / take) || 1,
      hasNext: skip + take < total,
      hasPrev: skip > 0,
    },
  };
}

async function getOrCreateConversation(businessId, { subjectType, subjectId }, requester = null) {
  // A cleaner can only ever open/fetch their own thread with the business —
  // ignore whatever subjectType/subjectId they sent and force it to their
  // own profile, rather than trusting client input for who they're messaging.
  if (requester?.businessRole === 'CLEANER') {
    subjectType = 'CLEANER';
    subjectId = requester.cleanerProfileId;
  }

  if (!['CLEANER', 'CUSTOMER'].includes(subjectType)) {
    const err = new Error('subjectType must be CLEANER or CUSTOMER');
    err.status = 422;
    throw err;
  }

  const subject = await resolveSubjectLabel(subjectType, subjectId);
  if (!subject) {
    const err = new Error(`${subjectType} not found`);
    err.status = 404;
    throw err;
  }

  // Ensure subject belongs to this business
  if (subjectType === 'CLEANER') {
    const ok = await prisma.cleanerProfile.findFirst({
      where: { id: subjectId, businessId },
    });
    if (!ok) {
      const err = new Error('Cleaner not in this business');
      err.status = 404;
      throw err;
    }
  } else {
    const ok = await prisma.customer.findFirst({
      where: { id: subjectId, businessId },
    });
    if (!ok) {
      const err = new Error('Customer not in this business');
      err.status = 404;
      throw err;
    }
  }

  let conv = await prisma.conversation.findFirst({
    where: { businessId, subjectType, subjectId },
  });
  if (!conv) {
    conv = await prisma.conversation.create({
      data: { businessId, subjectType, subjectId },
    });
  }

  return {
    id: conv.id,
    businessId: conv.businessId,
    subjectType: conv.subjectType,
    subjectId: conv.subjectId,
    subject,
    createdAt: conv.createdAt,
  };
}

async function listMessages(businessId, conversationId, { page = 1, limit = 50 } = {}, requester = null) {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, businessId },
  });
  if (!conv || !conversationBelongsToRequester(conv, requester)) {
    // 404, not 403 — don't confirm to a cleaner that a thread they're not
    // party to even exists.
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }

  const take = Math.min(Number(limit) || 50, 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const [total, messages] = await Promise.all([
    prisma.message.count({ where: { conversationId } }),
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      skip,
      take,
    }),
  ]);

  // Attach sender names
  const senderIds = [...new Set(messages.map((m) => m.senderUserId))];
  const users = await prisma.user.findMany({
    where: { id: { in: senderIds } },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));

  const data = messages.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    senderUserId: m.senderUserId,
    sender: userMap[m.senderUserId]
      ? {
          id: userMap[m.senderUserId].id,
          firstName: userMap[m.senderUserId].firstName,
          lastName: userMap[m.senderUserId].lastName,
          email: userMap[m.senderUserId].email,
        }
      : null,
    body: m.body,
    content: m.body, // alias for UIs that expect content
    attachmentKey: m.attachmentKey,
    readAt: m.readAt,
    status: m.readAt ? 'READ' : 'SENT',
    createdAt: m.createdAt,
  }));

  return {
    data,
    pagination: {
      page: Number(page) || 1,
      limit: take,
      total,
      totalPages: Math.ceil(total / take) || 1,
      hasNext: skip + take < total,
      hasPrev: skip > 0,
    },
  };
}

async function postMessage(businessId, conversationId, senderUserId, { body, content, attachmentKey }, requester = null) {
  if (attachmentKey) assertKeyUnderPrefix(attachmentKey, prefixes.tenant(businessId), 'attachmentKey');
  const text = (body ?? content ?? '').trim();
  if (!text && !attachmentKey) {
    const err = new Error('Message body is required');
    err.status = 422;
    throw err;
  }

  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, businessId },
  });
  if (!conv || !conversationBelongsToRequester(conv, requester)) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }

  const msg = await prisma.message.create({
    data: {
      conversationId,
      senderUserId,
      body: text || null,
      attachmentKey: attachmentKey || null,
    },
  });

  const sender = await prisma.user.findUnique({
    where: { id: senderUserId },
    select: { id: true, firstName: true, lastName: true, email: true },
  });

  return {
    id: msg.id,
    conversationId: msg.conversationId,
    senderUserId: msg.senderUserId,
    sender,
    body: msg.body,
    content: msg.body,
    attachmentKey: msg.attachmentKey,
    readAt: msg.readAt,
    status: 'SENT',
    createdAt: msg.createdAt,
  };
}

async function markMessageRead(businessId, messageId, userId, requester = null) {
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: true },
  });
  if (!msg || msg.conversation.businessId !== businessId || !conversationBelongsToRequester(msg.conversation, requester)) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }
  // Only mark others' messages as read
  if (msg.senderUserId === userId) return msg;

  return prisma.message.update({
    where: { id: messageId },
    data: { readAt: new Date() },
  });
}

/**
 * Search people you can start a thread with: active cleaners + customers in this business.
 */
async function searchRecipients(businessId, { search = '', page = 1, limit = 10 } = {}) {
  const q = String(search || '').trim();
  const take = Math.min(Number(limit) || 10, 30);

  const cleaners = await prisma.cleanerProfile.findMany({
    where: {
      businessId,
      status: { in: ['ACTIVE', 'PENDING'] },
      ...(q
        ? {
            user: {
              OR: [
                { firstName: { contains: q, mode: 'insensitive' } },
                { lastName: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    },
    include: { user: true },
    take,
  });

  const customers = await prisma.customer.findMany({
    where: {
      businessId,
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
            ],
          }
        : {}),
    },
    take,
  });

  return [
    ...cleaners.map((c) => ({
      subjectType: 'CLEANER',
      subjectId: c.id,
      name: `${c.user.firstName} ${c.user.lastName}`.trim(),
      email: c.user.email,
      subtitle: `Cleaner · ${c.status}`,
    })),
    ...customers.map((c) => ({
      subjectType: 'CUSTOMER',
      subjectId: c.id,
      name: `${c.firstName} ${c.lastName}`.trim(),
      email: c.email,
      phone: c.phone,
      subtitle: `Customer · ${c.phone || c.email || ''}`.trim(),
    })),
  ].slice(0, take);
}

module.exports = {
  listConversations,
  getOrCreateConversation,
  listMessages,
  postMessage,
  markMessageRead,
  searchRecipients,
};
