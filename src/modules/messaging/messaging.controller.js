const service = require('./messaging.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const result = await service.listConversations(
      req.businessId,
      { page: req.query.page, limit: req.query.limit },
      req.user
    );
    return res.status(200).json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (err) {
    next(err);
  }
}

async function createConversation(req, res, next) {
  try {
    const conv = await service.getOrCreateConversation(req.businessId, req.body, req.user);
    return success(res, 201, conv, 'Conversation ready');
  } catch (err) {
    next(err);
  }
}

async function listMessages(req, res, next) {
  try {
    const result = await service.listMessages(
      req.businessId,
      req.params.id,
      { page: req.query.page, limit: req.query.limit },
      req.user
    );
    return res.status(200).json({
      success: true,
      data: result.data,
      pagination: result.pagination,
    });
  } catch (err) {
    next(err);
  }
}

async function postMessage(req, res, next) {
  try {
    const msg = await service.postMessage(
      req.businessId,
      req.params.id,
      req.user.id,
      req.body,
      req.user
    );
    return success(res, 201, msg, 'Message posted');
  } catch (err) {
    next(err);
  }
}

async function markRead(req, res, next) {
  try {
    const msg = await service.markMessageRead(
      req.businessId,
      req.params.messageId,
      req.user.id,
      req.user
    );
    return success(res, 200, msg, 'Marked read');
  } catch (err) {
    next(err);
  }
}

async function searchRecipients(req, res, next) {
  try {
    const data = await service.searchRecipients(req.businessId, {
      search: req.query.search || req.query.q,
      page: req.query.page,
      limit: req.query.limit,
    });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  createConversation,
  listMessages,
  postMessage,
  markRead,
  searchRecipients,
};
