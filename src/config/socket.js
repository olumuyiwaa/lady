const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('./logger');
const { resolveRealtimeRole, canJoinConversation } = require('../lib/realtimeAccess');

let io;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: process.env.FRONTEND_URL, credentials: true },
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      // Customer-portal tokens carry a scope/audience and must not join
      // business rooms — they would receive every booking event in the tenant.
      if (payload.scope || payload.aud) return next(new Error('Unauthorized'));
      socket.userId = payload.sub;
      socket.businessId = payload.businessId || null;
      // The token is only checked at handshake. Remember when it expires so the
      // connection can be closed then; the client reconnects with its refreshed
      // token. Without this an expired (or revoked) session stayed connected
      // and kept receiving events indefinitely.
      socket.tokenExpiresAt = payload.exp ? payload.exp * 1000 : null;
      next();
    } catch (err) {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    socket.join(`user:${socket.userId}`);

    if (socket.tokenExpiresAt) {
      const ms = Math.max(socket.tokenExpiresAt - Date.now(), 0);
      const timer = setTimeout(() => socket.disconnect(true), ms);
      if (timer.unref) timer.unref();
      socket.on('disconnect', () => clearTimeout(timer));
    }

    // Only staff of this business get tenant-wide events.
    try {
      const role = await resolveRealtimeRole(socket.userId, socket.businessId);
      if (role.isStaff) socket.join(`business:${socket.businessId}`);
    } catch (e) {
      logger.error('failed to resolve realtime role', { error: e.message });
    }

    socket.on('join_conversation', async (conversationId) => {
      try {
        if (await canJoinConversation(socket.userId, socket.businessId, conversationId)) {
          socket.join(`conversation:${conversationId}`);
        }
      } catch (e) {
        logger.error('join_conversation failed', { error: e.message });
      }
    });
    socket.on('leave_conversation', (conversationId) => socket.leave(`conversation:${conversationId}`));
    socket.on('typing', ({ conversationId } = {}) => {
      // Only relay typing into rooms this socket was actually admitted to.
      if (!conversationId || !socket.rooms.has(`conversation:${conversationId}`)) return;
      socket.to(`conversation:${conversationId}`).emit('user_typing', { userId: socket.userId });
    });

    socket.on('disconnect', () => logger.debug(`socket disconnected: ${socket.id}`));
  });

  return io;
}

function getIo() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

module.exports = { initSocket, getIo };
