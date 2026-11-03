jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { verifyCaptcha, requireCaptcha, _resetWarning } = require('../src/lib/captcha');

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; _resetWarning(); jest.clearAllMocks(); });

const okFetch = (success) => jest.fn().mockResolvedValue({ json: async () => ({ success }) });

describe('verifyCaptcha', () => {
  test('is skipped when no secret is configured (local development)', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    await expect(verifyCaptcha(undefined, '1.1.1.1')).resolves.toBe(true);
  });
  test('accepts a token Cloudflare validates, sending the secret and IP', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    const f = okFetch(true);
    await expect(verifyCaptcha('tok', '9.9.9.9', { fetchImpl: f })).resolves.toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toContain('challenges.cloudflare.com');
    expect(init.body.get('secret')).toBe('sekret');
    expect(init.body.get('response')).toBe('tok');
    expect(init.body.get('remoteip')).toBe('9.9.9.9');
  });
  test('rejects an invalid, missing or oversized token', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    await expect(verifyCaptcha('tok', 'ip', { fetchImpl: okFetch(false) })).resolves.toBe(false);
    await expect(verifyCaptcha(undefined, 'ip', { fetchImpl: okFetch(true) })).resolves.toBe(false);
    await expect(verifyCaptcha('x'.repeat(3000), 'ip', { fetchImpl: okFetch(true) })).resolves.toBe(false);
  });
  test('fails closed when Cloudflare cannot be reached', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    await expect(verifyCaptcha('tok', 'ip', { fetchImpl: jest.fn().mockRejectedValue(new Error('down')) })).resolves.toBe(false);
  });
});

describe('requireCaptcha middleware', () => {
  const mk = () => { const res = {}; res.status = jest.fn().mockReturnValue(res); res.json = jest.fn().mockReturnValue(res); return res; };
  test('400 CAPTCHA_FAILED on a bad token, next() on a good one', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'sekret';
    const bad = mk(); const next = jest.fn();
    await requireCaptcha({ fetchImpl: okFetch(false) })({ body: { captchaToken: 't' }, headers: {}, ip: 'ip' }, bad, next);
    expect(bad.status).toHaveBeenCalledWith(400);
    expect(bad.json.mock.calls[0][0].errors.code).toBe('CAPTCHA_FAILED');
    expect(next).not.toHaveBeenCalled();

    const good = jest.fn();
    await requireCaptcha({ fetchImpl: okFetch(true) })({ body: {}, headers: { 'x-captcha-token': 't' }, ip: 'ip' }, mk(), good);
    expect(good).toHaveBeenCalled();
  });
});
