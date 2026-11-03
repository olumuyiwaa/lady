const service = require('./reports.service');
const { success } = require('../../utils/response');
const { toCsv } = require('../../utils/csv');

async function list(req, res, next) {
  try {
    const data = await service.generateSummary(req.businessId);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function kpis(req, res, next) {
  try {
    const data = await service.generateKPIs(req.businessId, { from: req.query.from, to: req.query.to });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function revenue(req, res, next) {
  try {
    const data = await service.revenueByDay(req.businessId, { from: req.query.from, to: req.query.to });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function cleanerPerf(req, res, next) {
  try {
    const data = await service.cleanerPerformance(req.businessId, { from: req.query.from, to: req.query.to });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function auditTrail(req, res, next) {
  try {
    const data = await service.auditTrail(req.businessId, {
      page: req.query.page,
      limit: req.query.limit,
      from: req.query.from,
      to: req.query.to,
      userId: req.query.userId,
      resource: req.query.resource,
      action: req.query.action,
    });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}


async function orgSummary(req, res, next) {
  try {
    // req.businessId is the caller's own business — for an org-level role
    // that's the parent, so this rolls up its own locations directly.
    const data = await service.orgSummary(req.businessId, { from: req.query.from, to: req.query.to });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

// "Advanced reports & exports" — a Pro-tier feature per the pricing page.
// Reuses the same service functions as the JSON endpoints above; only the
// response format differs.
async function revenueExport(req, res, next) {
  try {
    const data = await service.revenueByDay(req.businessId, { from: req.query.from, to: req.query.to });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="revenue.csv"');
    return res.status(200).send(toCsv(data));
  } catch (err) {
    next(err);
  }
}

async function cleanerPerfExport(req, res, next) {
  try {
    const data = await service.cleanerPerformance(req.businessId, { from: req.query.from, to: req.query.to });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="cleaner-performance.csv"');
    return res.status(200).send(toCsv(data));
  } catch (err) {
    next(err);
  }
}

module.exports = { list, kpis, revenue, cleanerPerf, auditTrail, orgSummary, revenueExport, cleanerPerfExport };
