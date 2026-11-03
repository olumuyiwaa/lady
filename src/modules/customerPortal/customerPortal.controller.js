const service = require('./customerPortal.service');
const { success } = require('../../utils/response');

async function requestAccess(req, res, next) {
  try {
    const data = await service.requestAccess(req.businessId, req.body);
    return success(res, 200, data, 'If an account exists, a code was sent');
  } catch (err) {
    next(err);
  }
}

async function verifyAccess(req, res, next) {
  try {
    const data = await service.verifyAccess(req.businessId, req.body);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function getInvoice(req, res, next) {
  try {
    const invoices = require('../invoices/invoices.service');
    const inv = await invoices.getInvoiceForBooking(req.businessId, req.params.id, req.portalCustomerId);
    return success(res, 200, inv);
  } catch (err) {
    next(err);
  }
}

async function getInvoiceHtml(req, res, next) {
  try {
    const invoices = require('../invoices/invoices.service');
    const prisma = require('../../config/database');
    const inv = await invoices.getInvoiceForBooking(req.businessId, req.params.id, req.portalCustomerId);
    const biz = await prisma.business.findUnique({ where: { id: req.businessId }, select: { timezone: true } });
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return res.send(invoices.renderInvoiceHtml(inv, biz && biz.timezone));
  } catch (err) {
    next(err);
  }
}

async function listBookings(req, res, next) {
  try {
    const data = await service.listMyBookings(req.businessId, req.portalCustomerId);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function getBooking(req, res, next) {
  try {
    const data = await service.getMyBooking(req.businessId, req.portalCustomerId, req.params.id);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function cancelBooking(req, res, next) {
  try {
    const data = await service.cancelMyBooking(req.businessId, req.portalCustomerId, req.params.id, req.body.reason);
    return success(res, 200, data, 'Booking cancelled');
  } catch (err) {
    next(err);
  }
}

async function rescheduleBooking(req, res, next) {
  try {
    const data = await service.rescheduleMyBooking(req.businessId, req.portalCustomerId, req.params.id, req.body);
    return success(res, 200, data, 'Booking rescheduled');
  } catch (err) {
    next(err);
  }
}

async function leaveReview(req, res, next) {
  try {
    const data = await service.leaveReview(req.businessId, req.portalCustomerId, req.params.id, req.body);
    return success(res, 201, data, 'Review submitted');
  } catch (err) {
    next(err);
  }
}

async function tipBooking(req, res, next) {
  try {
    const data = await service.tipMyBooking(req.businessId, req.portalCustomerId, req.params.id, req.body);
    return success(res, 200, data, 'Tip checkout session created');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getInvoice,
  getInvoiceHtml,
  requestAccess,
  verifyAccess,
  listBookings,
  getBooking,
  cancelBooking,
  rescheduleBooking,
  leaveReview,
  tipBooking,
};
