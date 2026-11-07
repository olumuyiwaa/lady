jest.mock('../src/config/database', () => ({
  business: { findUnique: jest.fn().mockResolvedValue({ name: 'Tod Cleaning Services', currency: 'eur', contactPhone: '+31201234567' }) },
  service: { findMany: jest.fn().mockResolvedValue([
    { name: 'Standard clean', pricingModel: 'HOURLY', basePriceCents: 3500, estimatedMinutes: 120, description: 'Regular home clean', addOns: [{ name: 'Inside oven', priceCents: 2500, extraMinutes: 30 }] },
  ]) },
  serviceArea: { findMany: jest.fn().mockResolvedValue([{ name: 'Amsterdam' }, { name: 'Amstelveen' }]) },
  businessHours: { findMany: jest.fn().mockResolvedValue([{ dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isClosed: false }, { dayOfWeek: 0, isClosed: true }]) },
  businessPricing: { findUnique: jest.fn().mockResolvedValue({ cancellationWindowHours: 24, cancellationFeeType: 'PERCENT', cancellationFeeValue: 50, referralEnabled: true, referralDiscountCents: 2000, referralRewardCents: 2000, frequencyDiscounts: { WEEKLY: 0.1 } }) },
  businessBranding: { findUnique: jest.fn().mockResolvedValue({ tagline: 'Spotless homes', aboutBody: null, faqItems: [{ question: 'Do you bring supplies?', answer: 'Yes, we bring everything.' }] }) },
}));
jest.mock('../src/config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const ctx = require('../src/modules/assistant/assistant.context');
const svc = require('../src/modules/assistant/assistant.service');

beforeEach(() => { ctx._cache.clear(); process.env.ANTHROPIC_API_KEY = 'key'; });
const ok = (text) => jest.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: 'text', text }] }) });

describe('context', () => {
  test('contains prices, add-ons, areas, hours, policy, referral and FAQ', async () => {
    const t = await ctx.getContext('b1');
    expect(t).toContain('Standard clean: €35.00 per hour');
    expect(t).toContain('add-on "Inside oven": €25.00');
    expect(t).toContain('SERVICE AREAS: Amsterdam, Amstelveen');
    expect(t).toContain('Monday 08:00-18:00');
    expect(t).toContain('Sunday closed');
    expect(t).toContain('50% of the price');
    expect(t).toContain('weekly 10%');
    expect(t).toContain('Do you bring supplies?');
  });
});

describe('cleanMessages', () => {
  test('keeps the last turns, starts and ends on the visitor, merges repeats', () => {
    const out = svc.cleanMessages([
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'a' }, { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' },
    ]);
    expect(out).toEqual([{ role: 'user', content: 'a\nb' }, { role: 'assistant', content: 'c' }, { role: 'user', content: 'd' }]);
  });
  test('rejects empty and assistant-last', () => {
    expect(() => svc.cleanMessages([])).toThrow();
    expect(() => svc.cleanMessages([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }])).toThrow(/last message/);
  });
  test('trims long content', () => {
    expect(svc.cleanMessages([{ role: 'user', content: 'x'.repeat(5000) }])[0].content).toHaveLength(1000);
  });
});

describe('ask', () => {
  test('sends grounded system prompt and returns the reply', async () => {
    const fetchImpl = ok('Een standaard schoonmaak kost €35 per uur incl. btw.');
    const out = await svc.ask('b1', { messages: [{ role: 'user', content: 'Wat kost het?' }], language: 'nl' }, { fetchImpl });
    expect(out).toEqual({ reply: 'Een standaard schoonmaak kost €35 per uur incl. btw.', language: 'nl' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('key');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.system).toContain('Standard clean: €35.00 per hour');
    expect(body.system).toContain('Reply in Dutch');
    expect(body.messages).toEqual([{ role: 'user', content: 'Wat kost het?' }]);
  });
  test('is disabled without an API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(svc.ask('b1', { messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ status: 503, code: 'ASSISTANT_DISABLED' });
  });
  test('API failure becomes a 502 without leaking details', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(svc.ask('b1', { messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl })).rejects.toMatchObject({ status: 502, code: 'ASSISTANT_ERROR' });
  });
  test('network failure becomes a 502', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('down'));
    await expect(svc.ask('b1', { messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl })).rejects.toMatchObject({ status: 502, code: 'ASSISTANT_UNREACHABLE' });
  });
});
