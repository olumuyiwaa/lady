#!/usr/bin/env node
/**
 * Smoke test for a deployed API. Read-only unless you opt in.
 *
 *   API_BASE_URL=https://staging.example.com/api/v1 node scripts/stagingSmoke.js
 *
 * Optional:
 *   SMOKE_STAFF_EMAIL / SMOKE_STAFF_PASSWORD   also check staff login, leave, dispatch, calendar
 *   SMOKE_POSTCODE=1012AB                      postcode to check (default 1012AB)
 *   SMOKE_CREATE_BOOKING=1                     create a real booking named "SMOKE TEST"
 *                                              (staging only, captcha must be off; cancel it afterwards)
 *
 * Exit code is 1 when any check fails.
 */
const BASE = (process.env.API_BASE_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '');
const ROOT = BASE.replace(/\/api\/v1$/, '');
const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}

async function call(path, { method = 'GET', body, token, base = BASE, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const data = (r) => (r.json && r.json.data) || null;

(async () => {
  let storefront;
  let service;

  await check('health endpoint', async () => {
    const r = await call('/health', { base: ROOT });
    expect(r.status === 200, `status ${r.status}`);
  });

  await check('storefront has services, hours and a business', async () => {
    const r = await call('/widget/storefront');
    expect(r.status === 200, `status ${r.status}`);
    storefront = data(r);
    expect(storefront.services.length > 0, 'no active services');
    expect(storefront.onboardingComplete, 'onboarding incomplete (services, opening hours, service area)');
    service = storefront.services[0];
    return `${storefront.services.length} services, assistant ${storefront.assistantEnabled ? 'on' : 'off'}, card ${storefront.payment?.onlineCardReady ? 'ready' : 'NOT ready'}`;
  });

  await check('online card payment is ready (Stripe connected)', async () => {
    expect(storefront?.payment?.onlineCardReady, 'storefront.payment.onlineCardReady is false: check STRIPE_SECRET_KEY');
  });

  await check('postcode checker answers', async () => {
    const pc = process.env.SMOKE_POSTCODE || '1012AB';
    const r = await call(`/widget/service-area?postalCode=${pc}`);
    expect(r.status === 200, `status ${r.status}`);
    return JSON.stringify(data(r));
  });

  await check('quote for the first service', async () => {
    const r = await call('/widget/quote', { method: 'POST', body: { serviceId: service.id, rooms: 3, bathrooms: 1, sqft: 70, frequency: 'WEEKLY' } });
    expect(r.status === 200, `status ${r.status} ${r.text.slice(0, 120)}`);
    const q = data(r);
    expect(Number.isFinite(q.priceCents) && q.priceCents > 0, 'no price in quote');
  });

  await check('slots for tomorrow', async () => {
    const d = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const r = await call(`/widget/slots?serviceId=${service.id}&date=${d}`);
    expect(r.status === 200, `status ${r.status}`);
    const s = data(r);
    return `${(s.slots || s).length} slots on ${d}`;
  });

  if (storefront && storefront.assistantEnabled) {
    await check('AI assistant answers from business data', async () => {
      const r = await call('/widget/assistant', { method: 'POST', body: { language: 'en', messages: [{ role: 'user', content: 'What services do you offer and roughly what do they cost?' }] } });
      expect(r.status === 200, `status ${r.status} ${r.text.slice(0, 120)}`);
      const reply = data(r).reply;
      expect(reply && reply.length > 20, 'empty reply');
      return reply.slice(0, 90).replace(/\s+/g, ' ');
    });
  }

  await check('Stripe webhook rejects unsigned requests (reachable, verifying signatures)', async () => {
    const r = await call('/webhooks/stripe', { method: 'POST', body: { id: 'evt_smoke', type: 'ping' } });
    expect([400, 401, 403].includes(r.status), `expected 400/401/403, got ${r.status}`);
  });

  await check('WhatsApp webhook rejects unsigned requests', async () => {
    const r = await call('/webhooks/whatsapp', { method: 'POST', body: { From: 'whatsapp:+31600000000', Body: 'STOP' } });
    expect(r.status === 403, `expected 403, got ${r.status}`);
  });

  if (process.env.SMOKE_STAFF_EMAIL && process.env.SMOKE_STAFF_PASSWORD) {
    let token;
    await check('staff login', async () => {
      const r = await call('/auth/login', { method: 'POST', body: { email: process.env.SMOKE_STAFF_EMAIL, password: process.env.SMOKE_STAFF_PASSWORD } });
      expect(r.status === 200, `status ${r.status}`);
      token = data(r).accessToken || data(r).token;
      expect(token, 'no access token in login response');
    });
    if (token) {
      for (const [name, path] of [['leave list', '/leave'], ['dispatch list', '/dispatch'], ['cleaners', '/cleaners'], ['insights', '/reports/insights']]) {
        await check(`staff: ${name}`, async () => {
          const r = await call(path, { token });
          expect(r.status === 200, `status ${r.status}`);
        });
      }
    }
  }

  if (process.env.SMOKE_CREATE_BOOKING === '1') {
    await check('create a booking (SMOKE TEST) with language and WhatsApp consent', async () => {
      const slotsRes = await call(`/widget/slots?serviceId=${service.id}&date=${new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)}`);
      const slots = data(slotsRes).slots || data(slotsRes);
      expect(slots.length, 'no slot to book');
      const first = slots[0];
      const r = await call('/widget/bookings', {
        method: 'POST',
        body: {
          firstName: 'SMOKE', lastName: 'TEST', email: process.env.SMOKE_EMAIL || 'smoke@example.com', phone: process.env.SMOKE_PHONE || '+31612345678',
          language: 'nl', whatsappOptIn: false,
          addressLine1: 'Dam 1', city: 'Amsterdam', state: 'NH', postalCode: '1012JS',
          serviceId: service.id, scheduledStart: first.start || first.scheduledStart || first,
        },
      });
      expect(r.status === 201, `status ${r.status} ${r.text.slice(0, 160)}`);
      return `created ${data(r).id || ''}: cancel it in the dashboard`;
    });
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed against ${BASE}`);
  process.exit(failed ? 1 : 0);
})();
