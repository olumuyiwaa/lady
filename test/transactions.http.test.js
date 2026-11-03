jest.mock('../src/config/database.js', () => ({ business: { findFirst: jest.fn() } }));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Real requireRole; only the login step is replaced, driven by a test header.
jest.mock('../src/middleware/authenticate', () => ({
  ...jest.requireActual('../src/middleware/authenticate'),
  authenticate: (req, res, next) => {
    const raw = req.headers['x-test-user'];
    if (!raw) return res.status(401).json({ success: false, message: 'Missing access token' });
    req.user = JSON.parse(raw);
    return next();
  },
}));
jest.mock('../src/middleware/requireActiveSubscription', () => ({ requireActiveSubscription: (req, res, next) => next() }));
let mockPlanAllows = true;
jest.mock('../src/lib/planFeatures', () => ({
  hasPlanFeature: jest.fn(),
  requirePlanFeature: (key, label) => (req, res, next) =>
    mockPlanAllows ? next() : res.status(402).json({ success: false, message: `${label} isn't included in your current plan. Upgrade to use it.` }),
}));
jest.mock('../src/modules/transactions/transactions.service', () => ({ list: jest.fn(), summary: jest.fn(), exportRows: jest.fn() }));
jest.mock('../src/middleware/validate', () => (req, res, next) => next());

const express = require('express');
const request = require('supertest');
const prisma = require('../src/config/database.js');
const svc = require('../src/modules/transactions/transactions.service');
const errorHandler = require('../src/middleware/errorHandler');

const app = express();
app.use('/api/v1/transactions', require('../src/modules/transactions/transactions.routes'));
app.use(errorHandler);

const as = (u) => JSON.stringify(u);
const owner = { id: 'u1', businessId: 'biz1', businessRole: 'BUSINESS_OWNER' };
const manager = { id: 'u2', businessId: 'biz1', businessRole: 'BUSINESS_MANAGER' };
const cleaner = { id: 'u3', businessId: 'biz1', businessRole: 'CLEANER' };
const admin = { id: 'u9', globalRole: 'SUPER_ADMIN' };
const page = { items: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 } };

beforeEach(() => {
  jest.resetAllMocks();
  mockPlanAllows = true;
  svc.list.mockResolvedValue(page);
  svc.summary.mockResolvedValue({ byCurrency: [] });
  svc.exportRows.mockResolvedValue([]);
});

describe('business endpoints', () => {
  test.each(['/', '/summary', '/export'])('GET %s needs a login', async (p) => {
    expect((await request(app).get(`/api/v1/transactions${p}`)).status).toBe(401);
  });

  test.each([['owner', owner], ['manager', manager]])('a %s can read the log', async (_n, u) => {
    const res = await request(app).get('/api/v1/transactions').set('x-test-user', as(u));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: null, data: page });
  });

  test.each(['/', '/summary', '/export'])('a cleaner is refused %s (403) and the service is never called', async (p) => {
    const res = await request(app).get(`/api/v1/transactions${p}`).set('x-test-user', as(cleaner));
    expect(res.status).toBe(403);
    expect(svc.list).not.toHaveBeenCalled();
    expect(svc.summary).not.toHaveBeenCalled();
    expect(svc.exportRows).not.toHaveBeenCalled();
  });

  test("the business comes from the login, never from the query string: a foreign businessId is ignored", async () => {
    const res = await request(app).get('/api/v1/transactions?businessId=OTHER').set('x-test-user', as(owner));
    expect(res.status).toBe(200);
    const [scope] = svc.list.mock.calls[0];
    expect(scope.businessId).toBe(owner.businessId);
  });

  test('the service is scoped to the logged-in business and receives only the known filters', async () => {
    await request(app).get('/api/v1/transactions?type=TIP&status=SUCCEEDED&page=2&evil=1&__proto__=x').set('x-test-user', as(owner));
    const [scope, filters] = svc.list.mock.calls[0];
    expect(scope).toEqual({ businessId: 'biz1' });
    expect(filters).toEqual({ type: 'TIP', status: 'SUCCEEDED', page: '2' });
  });

  test('a validation problem from the service reaches the client as a 422 with its message', async () => {
    svc.list.mockRejectedValue(Object.assign(new Error('Unknown type: LOTTERY'), { status: 422 }));
    const res = await request(app).get('/api/v1/transactions?type=LOTTERY').set('x-test-user', as(owner));
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('Unknown type: LOTTERY');
  });

  test('an unexpected failure is a plain 500 that leaks nothing', async () => {
    svc.list.mockRejectedValue(new Error('connection string postgres://secret'));
    const res = await request(app).get('/api/v1/transactions').set('x-test-user', as(owner));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('business export', () => {
  test('is a plan feature: without it, 402 and nothing is built', async () => {
    mockPlanAllows = false;
    const res = await request(app).get('/api/v1/transactions/export').set('x-test-user', as(owner));
    expect(res.status).toBe(402);
    expect(res.body.message).toContain('Transaction export');
    expect(svc.exportRows).not.toHaveBeenCalled();
  });

  test('returns a UTF-8 CSV download with a BOM, a dated filename, and numeric signed amounts', async () => {
    svc.exportRows.mockResolvedValue([
      { date: '2026-05-01T10:00:00.000Z', type: 'DEPOSIT', amount: 20.5, currency: 'EUR', counterparty: 'Zoë, "Z" de Vries' },
      { date: '2026-05-02T10:00:00.000Z', type: 'REFUND', amount: -10, currency: 'EUR', counterparty: 'Anna' },
    ]);
    const res = await request(app).get('/api/v1/transactions/export').set('x-test-user', as(owner));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="transactions-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const lines = res.text.slice(1).split('\n');
    expect(lines[0]).toBe('date,type,amount,currency,counterparty');
    expect(lines[1]).toContain('20.5');
    expect(lines[1]).toContain('"Zoë, ""Z"" de Vries"'); // commas and quotes escaped
    expect(lines[2]).toContain('-10');
  });

  test('an over-large export is a 422 telling the user to narrow the range', async () => {
    svc.exportRows.mockRejectedValue(Object.assign(new Error('Too many transactions to export at once. Narrow the date range.'), { status: 422 }));
    const res = await request(app).get('/api/v1/transactions/export').set('x-test-user', as(owner));
    expect(res.status).toBe(422);
    expect(res.body.message).toContain('Narrow the date range');
  });
});

