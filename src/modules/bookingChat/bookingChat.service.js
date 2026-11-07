/**
 * Per-booking chat between a customer and the cleaner(s) assigned to the job.
 *
 * Messages reuse the existing Conversation/Message tables with
 * subjectType 'BOOKING' and subjectId = the booking id, so no new tables are
 * needed. These threads are filtered out of the staff inbox (see
 * messaging.service listConversations).
 *
 * Who may use it:
 *   - the customer who owns the booking (customer portal token), and
 *   - a cleaner assigned to that booking (cleaner login).
 * The chat is open once a cleaner is assigned, and closes 48 hours after the
 * job is completed or as soon as it is cancelled. History stays readable.
 */
const prisma = require('../../config/database');
const logger = require('../../config/logger');

const SUBJECT_TYPE = 'BOOKING';
const CHAT_WINDOW_AFTER_MS = 48 * 60 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_MESSAGES_PER_HOUR = 30;
const EMAIL_THROTTLE_MS = 10 * 60 * 1000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Loads the booking if `party` may chat on it.
 * party: { type: 'CUSTOMER', customerId, userId } | { type: 'CLEANER', cleanerId, userId }
 */
async function loadContext(businessId, bookingId, party) {
  const where = { id: bookingId, businessId };
  if (party.type === 'CUSTOMER') where.customerId = party.customerId;
  else where.assignments = { some: { cleanerId: party.cleanerId } };

  const booking = await prisma.booking.findFirst({
    where,
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, language: true, whatsappOptInAt: true, whatsappOptOutAt: true } },
      assignments: {
        include: { cleaner: { include: { user: { select: { id: true, firstName: true, lastName: true } } } } },
      },
    },
  });
  // 404 either way: never confirm that someone else's booking exists.
  if (!booking) throw httpError(404, 'Booking not found');
  return booking;
}

/** Whether new messages may be sent right now, and why not if closed. */
function chatState(booking, now = Date.now()) {
  if (!booking.assignments || booking.assignments.length === 0) {
    return { open: false, reason: 'NO_CLEANER' };
  }
  if (booking.status === 'CANCELLED') return { open: false, reason: 'CANCELLED' };
  if (booking.status === 'COMPLETED') {
    const doneAt = Math.max(
      new Date(booking.updatedAt || 0).getTime(),
      ...booking.assignments.map((a) => (a.checkedOutAt ? new Date(a.checkedOutAt).getTime() : 0))
    );
    if (now - doneAt > CHAT_WINDOW_AFTER_MS) return { open: false, reason: 'CLOSED' };
  }
  return { open: true, reason: null };
}

async function getOrCreateConversation(businessId, bookingId) {
  const existing = await prisma.conversation.findFirst({
    where: { businessId, subjectType: SUBJECT_TYPE, subjectId: bookingId },
  });
  if (existing) return existing;
  return prisma.conversation.create({ data: { businessId, subjectType: SUBJECT_TYPE, subjectId: bookingId } });
}

function counterpartLabel(booking, party) {
  if (party.type === 'CUSTOMER') {
    const names = booking.assignments
      .map((a) => a.cleaner?.user?.firstName)
      .filter(Boolean);
    return [...new Set(names)].join(', ') || null;
  }
  return booking.customer?.firstName || null;
}

/** Messages (oldest first) plus whether the chat is currently open. Marks the other side's messages read. */
async function listMessages(businessId, bookingId, party, { after } = {}) {
  const booking = await loadContext(businessId, bookingId, party);
  const state = chatState(booking);
  const conv = await prisma.conversation.findFirst({
    where: { businessId, subjectType: SUBJECT_TYPE, subjectId: bookingId },
  });

  const base = { open: state.open, closedReason: state.reason, with: counterpartLabel(booking, party) };
  if (!conv) return { ...base, messages: [] };

  const afterDate = after ? new Date(after) : null;
  const rows = await prisma.message.findMany({
    where: {
      conversationId: conv.id,
      ...(afterDate && !Number.isNaN(afterDate.getTime()) ? { createdAt: { gt: afterDate } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });

  const senderIds = [...new Set(rows.map((m) => m.senderUserId))];
  const users = senderIds.length
    ? await prisma.user.findMany({
        where: { id: { in: senderIds } },
        select: { id: true, email: true, firstName: true },
      })
    : [];
  const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
  const cleanerUserIds = new Set(booking.assignments.map((a) => a.cleaner?.userId).filter(Boolean));

  const messages = rows.map((m) => {
    const u = userMap[m.senderUserId];
    let role = 'STAFF';
    if (cleanerUserIds.has(m.senderUserId)) role = 'CLEANER';
    else if (u && /@portal\.invalid$/.test(u.email || '')) role = 'CUSTOMER';
    return {
      id: m.id,
      role,
      mine: m.senderUserId === party.userId,
      name: u?.firstName || null,
      body: m.body,
      createdAt: m.createdAt,
      readAt: m.readAt,
    };
  });

  // Anything the other side sent is now read.
  const unread = rows.filter((m) => m.senderUserId !== party.userId && !m.readAt).map((m) => m.id);
  if (unread.length) {
    await prisma.message.updateMany({ where: { id: { in: unread } }, data: { readAt: new Date() } });
  }

  return { ...base, messages };
}

async function postMessage(businessId, bookingId, party, { body }) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) throw httpError(422, 'Message cannot be empty');
  if (text.length > MAX_MESSAGE_LENGTH) throw httpError(422, `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`);

  const booking = await loadContext(businessId, bookingId, party);
  const state = chatState(booking);
  if (!state.open) {
    throw httpError(409, state.reason === 'NO_CLEANER' ? 'A cleaner has not been assigned yet' : 'Chat is closed for this booking');
  }

  const conv = await getOrCreateConversation(businessId, bookingId);

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await prisma.message.count({
    where: { conversationId: conv.id, senderUserId: party.userId, createdAt: { gte: hourAgo } },
  });
  if (recent >= MAX_MESSAGES_PER_HOUR) throw httpError(429, 'You are sending messages too quickly. Please wait a little.');

  const previous = await prisma.message.findFirst({
    where: { conversationId: conv.id, senderUserId: party.userId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  const msg = await prisma.message.create({
    data: { conversationId: conv.id, senderUserId: party.userId, body: text },
  });

  notifyCounterpart(booking, party, text, previous?.createdAt).catch((e) => logger.error('booking chat notify failed', e));

  const senderFirst = party.type === 'CUSTOMER' ? booking.customer?.firstName : null;
  return {
    id: msg.id,
    role: party.type,
    mine: true,
    name: senderFirst || null,
    body: msg.body,
    createdAt: msg.createdAt,
    readAt: null,
  };
}

/**
 * Tell the other side there is a new message. Customer -> cleaner is a push
 * notification (free); cleaner -> customer is an email, at most one per 10
 * minutes of a conversation burst, because customers have no app and SMS costs
 * money.
 */
async function notifyCounterpart(booking, party, text, previousSentAt) {
  const notifications = require('../notifications/notifications.service');
  const preview = text.length > 80 ? `${text.slice(0, 77)}...` : text;

  if (party.type === 'CUSTOMER') {
    const name = booking.customer?.firstName || 'Your customer';
    for (const a of booking.assignments) {
      const uid = a.cleaner?.userId;
      if (!uid) continue;
      await notifications.pushToCleanerByUserId(uid, {
        title: `Message from ${name}`,
        body: preview,
        data: { type: 'BOOKING_MESSAGE', bookingId: booking.id },
      });
    }
    return;
  }

  if (previousSentAt && Date.now() - new Date(previousSentAt).getTime() < EMAIL_THROTTLE_MS) return;
  const email = booking.customer?.email;
  if (!email) return;
  const cleaner = booking.assignments.find((a) => a.cleaner?.userId === party.userId)?.cleaner?.user;
  const who = cleaner?.firstName || 'Your cleaner';
  const business = await prisma.business.findUnique({ where: { id: booking.businessId }, select: { name: true } });
  await require('../../lib/customerNotify').notifyCustomer(booking.customer, 'chatMessage', { business: business?.name || 'Tod Cleaning Services', who, preview }, { phone: false });
}

/** Unread messages from cleaners across all of a customer's bookings. */
async function unreadForCustomer(businessId, customerId, userId) {
  const bookings = await prisma.booking.findMany({
    where: { businessId, customerId, status: { notIn: ['CANCELLED'] } },
    select: { id: true },
    orderBy: { scheduledStart: 'desc' },
    take: 50,
  });
  if (bookings.length === 0) return 0;
  const convs = await prisma.conversation.findMany({
    where: { businessId, subjectType: SUBJECT_TYPE, subjectId: { in: bookings.map((b) => b.id) } },
    select: { id: true },
  });
  if (convs.length === 0) return 0;
  return prisma.message.count({
    where: {
      conversationId: { in: convs.map((c) => c.id) },
      senderUserId: { not: userId },
      readAt: null,
    },
  });
}

module.exports = {
  SUBJECT_TYPE,
  MAX_MESSAGE_LENGTH,
  chatState,
  listMessages,
  postMessage,
  unreadForCustomer,
};
