const service = require('./supportTickets.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const data = await service.listTickets(req.businessId, {
      status: req.query.status,
      priority: req.query.priority,
      q: req.query.q,
      page: req.query.page,
      limit: req.query.limit,
    });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function get(req, res, next) {
  try {
    const ticket = await service.getTicket(req.businessId, req.params.id);
    return success(res, 200, ticket);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const ticket = await service.createTicket(req.businessId, req.user.id, req.body);
    return success(res, 201, ticket, 'Ticket created');
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const ticket = await service.updateTicket(req.businessId, req.params.id, req.user.id, req.body);
    return success(res, 200, ticket, 'Ticket updated');
  } catch (err) {
    next(err);
  }
}

async function addMessage(req, res, next) {
  try {
    const message = await service.addMessage(req.businessId, req.params.id, req.user.id, req.body);
    return success(res, 201, message, 'Message added');
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteTicket(req.businessId, req.params.id, req.user.id);
    return success(res, 200, null, 'Ticket deleted');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, get, create, update, addMessage, remove };
