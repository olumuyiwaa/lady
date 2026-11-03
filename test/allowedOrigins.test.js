const express = require('express');
const cors = require('cors');
const request = require('supertest');
const { isOriginAllowed, corsOptions } = require('../src/lib/allowedOrigins');

const prod = (over = {}) => ({ NODE_ENV: 'production', FRONTEND_URL: 'https://app.ladygreener.nl', ...over });

describe('isOriginAllowed', () => {
  test('allows the configured frontend and rejects other origins', () => {
    const env = prod();
    expect(isOriginAllowed('https://app.ladygreener.nl', { env })).toBe(true);
    expect(isOriginAllowed('https://evil.example', { env })).toBe(false);
    expect(isOriginAllowed('https://app.ladygreener.nl.evil.example', { env })).toBe(false);
  });

  test('requests without an Origin header are not subject to CORS', () => {
    expect(isOriginAllowed(undefined, { env: prod() })).toBe(true);
  });

  test('a trailing slash, path or different case in FRONTEND_URL still matches', () => {
    expect(isOriginAllowed('https://app.ladygreener.nl', { env: prod({ FRONTEND_URL: 'https://app.ladygreener.nl/' }) })).toBe(true);
    expect(isOriginAllowed('https://app.ladygreener.nl', { env: prod({ FRONTEND_URL: 'https://App.LadyGreener.nl/dashboard' }) })).toBe(true);
  });

  test('FRONTEND_URL may be a comma-separated list', () => {
    const env = prod({ FRONTEND_URL: 'https://app.ladygreener.nl, https://staging.ladygreener.nl/' });
    expect(isOriginAllowed('https://staging.ladygreener.nl', { env })).toBe(true);
    expect(isOriginAllowed('https://other.ladygreener.nl', { env })).toBe(false);
  });

  test('WIDGET_BASE_DOMAIN allows its https subdomains, not look-alikes or plain http in production', () => {
    const env = prod({ WIDGET_BASE_DOMAIN: 'widget.ladygreener.nl' });
    expect(isOriginAllowed('https://widget.ladygreener.nl', { env })).toBe(true);
    expect(isOriginAllowed('https://a.widget.ladygreener.nl', { env })).toBe(true);
    expect(isOriginAllowed('http://a.widget.ladygreener.nl', { env })).toBe(false);
    expect(isOriginAllowed('https://evilwidget.ladygreener.nl', { env })).toBe(false);
    expect(isOriginAllowed('https://widget.ladygreener.nl.evil.example', { env })).toBe(false);
  });

  test('widget: false (sockets) ignores WIDGET_BASE_DOMAIN', () => {
    const env = prod({ WIDGET_BASE_DOMAIN: 'widget.ladygreener.nl' });
    expect(isOriginAllowed('https://a.widget.ladygreener.nl', { env, widget: false })).toBe(false);
    expect(isOriginAllowed('https://app.ladygreener.nl', { env, widget: false })).toBe(true);
  });

  test('localhost dev origins are allowed outside production only', () => {
    expect(isOriginAllowed('http://localhost:3000', { env: { NODE_ENV: 'development' } })).toBe(true);
    expect(isOriginAllowed('http://localhost:3000', { env: prod() })).toBe(false);
  });
});

describe('corsOptions on a real Express app', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  function app() {
    const a = express();
    a.use(cors(corsOptions()));
    a.get('/x', (req, res) => res.json({ ok: true }));
    return a;
  }

  test('an allowed origin gets the CORS header', async () => {
    Object.assign(process.env, prod());
    const res = await request(app()).get('/x').set('Origin', 'https://app.ladygreener.nl');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.ladygreener.nl');
  });

  test('a blocked origin is answered normally, without CORS headers (no 500)', async () => {
    Object.assign(process.env, prod());
    const res = await request(app()).get('/x').set('Origin', 'https://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('a preflight from a blocked origin gets no allow headers', async () => {
    Object.assign(process.env, prod());
    const res = await request(app()).options('/x').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBeLessThan(500);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
