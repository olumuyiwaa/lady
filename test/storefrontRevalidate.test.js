jest.mock('../src/config/database.js', () => ({ business: { findUnique: jest.fn() } }));
jest.mock('../src/config/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const prisma = require('../src/config/database.js');
const logger = require('../src/config/logger');
const { revalidateStorefront } = require('../src/lib/storefrontRevalidate');

const ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV, REVALIDATE_SECRET: 's3cret', FRONTEND_URL: 'https://app.todcleaning.nl/' };
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  prisma.business.findUnique.mockResolvedValue({ subdomain: 'acme' });
});
afterAll(() => { process.env = ENV; });

test('posts the business slug with the shared secret', async () => {
  await revalidateStorefront('biz1');
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = global.fetch.mock.calls[0];
  expect(url).toBe('https://app.todcleaning.nl/api/revalidate'); // trailing slash trimmed
  expect(init.headers['x-revalidate-secret']).toBe('s3cret');
  expect(JSON.parse(init.body)).toEqual({ slugs: ['acme'] });
});

test('includes extra slugs (e.g. a previous subdomain) and de-duplicates', async () => {
  await revalidateStorefront('biz1', ['old-name', 'acme']);
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ slugs: ['acme', 'old-name'] });
});

test('is a silent no-op when not configured', async () => {
  delete process.env.REVALIDATE_SECRET;
  await revalidateStorefront('biz1');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('never throws when the frontend is down', async () => {
  global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
  await expect(revalidateStorefront('biz1')).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalled();
});

test('never throws when the lookup fails, and logs a rejected call', async () => {
  prisma.business.findUnique.mockRejectedValue(new Error('db down'));
  await expect(revalidateStorefront('biz1')).resolves.toBeUndefined();
  prisma.business.findUnique.mockResolvedValue({ subdomain: 'acme' });
  global.fetch.mockResolvedValue({ ok: false, status: 401 });
  await revalidateStorefront('biz1');
  expect(logger.warn).toHaveBeenCalledWith('storefront revalidation rejected', expect.objectContaining({ status: 401 }));
});
