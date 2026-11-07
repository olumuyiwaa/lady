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

const chat = require('../bookingChat/bookingChat.service');

const handler = (fn, status = 200) => async (req, res, next) => {
  try {
    return success(res, status, await fn(req));
  } catch (err) {
    next(err);
  }
};

const party = (req) => ({ type: 'CUSTOMER', customerId: req.portalCustomerId, userId: req.portalUserId });

const getOverview = handler((req) => service.getOverview(req.businessId, req.portalCustomerId, req.portalUserId));
const getReferral = handler((req) => service.getReferral(req.businessId, req.portalCustomerId));
const listMyCleaners = handler((req) => service.listMyCleaners(req.businessId, req.portalCustomerId));
const setPreferredCleaner = handler((req) =>
  service.setPreferredCleaner(req.businessId, req.portalCustomerId, req.body.cleanerId || null)
);
const b2bService = require('../b2b/b2b.service');
const b2bSummary = handler((req) => b2bService.getSummary(req.businessId, req.portalCustomerId, req.query.month));
async function b2bExportCsv(req, res, next) {
  try {
    const csv = await b2bService.exportVisitsCsv(req.businessId, req.portalCustomerId, { from: req.query.from, to: req.query.to, month: req.query.month });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="visits.csv"');
    res.set('Cache-Control', 'no-store');
    return res.send(csv);
  } catch (err) {
    next(err);
  }
}
async function b2bStatementHtml(req, res, next) {
  try {
    const html = await b2bService.renderStatementHtml(req.businessId, req.portalCustomerId, req.query.month);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    return res.send(html);
  } catch (err) {
    next(err);
  }
}
const b2bQuality = handler((req) => b2bService.getQualityReport(req.businessId, req.portalCustomerId, req.query.month));
async function b2bQualityPdf(req, res, next) {
  try {
    const pdf = await b2bService.renderQualityPdfFor(req.businessId, req.portalCustomerId, req.query.month);
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : 'report';
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="quality-${month}.pdf"`);
    res.set('Cache-Control', 'no-store');
    return res.send(pdf);
  } catch (err) {
    next(err);
  }
}
const complaints = require('../supportTickets/complaints.service');
const createComplaint = handler((req) => complaints.createComplaint(req.businessId, req.portalCustomerId, req.params.id, req.body), 201);
const listComplaints = handler((req) => complaints.listMyComplaints(req.businessId, req.portalCustomerId));
const getTimeline = handler((req) => service.getMyTimeline(req.businessId, req.portalCustomerId, req.params.id));
const listMessages = handler((req) =>
  chat.listMessages(req.businessId, req.params.id, party(req), { after: req.query.after })
);
const postMessage = handler((req) => chat.postMessage(req.businessId, req.params.id, party(req), req.body), 201);

module.exports = {
  b2bSummary,
  b2bExportCsv,
  b2bStatementHtml,
  b2bQuality,
  b2bQualityPdf,
  createComplaint,
  listComplaints,
  getOverview,
  getReferral,
  listMyCleaners,
  setPreferredCleaner,
  getTimeline,
  listMessages,
  postMessage,
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
