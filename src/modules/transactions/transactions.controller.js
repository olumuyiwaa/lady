const service = require('./transactions.service');
const { success } = require('../../utils/response');
const { toCsv } = require('../../utils/csv');

// Query-string keys the list, summary and export all understand.
const FILTER_KEYS = ['type', 'direction', 'status', 'method', 'from', 'to', 'q', 'sort', 'order', 'page', 'limit', 'businessId'];

function filtersFrom(query) {
  const out = {};
  for (const k of FILTER_KEYS) if (query[k] !== undefined) out[k] = query[k];
  return out;
}

// A business is pinned to its own id; the query string cannot change that.
const businessScope = (req) => ({ businessId: req.businessId });
// The platform admin sees every business and may narrow with ?businessId=.
const adminScope = () => ({});

function csvResponse(res, rows, prefix) {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${prefix}-${stamp}.csv"`);
  // BOM so Excel reads names and the euro sign as UTF-8.
  return res.status(200).send(`\uFEFF${toCsv(rows)}`);
}

const handler = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  list: handler(async (req, res) => success(res, 200, await service.list(businessScope(req), filtersFrom(req.query)))),
  summary: handler(async (req, res) => success(res, 200, await service.summary(businessScope(req), filtersFrom(req.query)))),
  exportCsv: handler(async (req, res) => csvResponse(res, await service.exportRows(businessScope(req), filtersFrom(req.query)), 'transactions')),

  adminList: handler(async (req, res) => success(res, 200, await service.list(adminScope(), filtersFrom(req.query)))),
  adminSummary: handler(async (req, res) => success(res, 200, await service.summary(adminScope(), filtersFrom(req.query)))),
  adminExportCsv: handler(async (req, res) => csvResponse(res, await service.exportRows(adminScope(), filtersFrom(req.query)), 'platform-transactions')),
};
