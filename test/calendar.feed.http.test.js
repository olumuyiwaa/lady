jest.mock('../src/config/database.js', () => ({
  calendarFeed: { findUnique: jest.fn(), update: jest.fn() },
  businessMember: { findFirst: jest.fn() },
  booking: { findMany: jest.fn() },
}));
const express = require('express');
const request = require('supertest');
const prisma = require('../src/config/database.js');

const app = express();
app.use('/api/v1/calendar-feed', require('../src/modules/calendar/calendarFeed.public.routes'));
app.use((err, req, res, next) => res.status(err.status || 500).json({ message: err.message })); // eslint-disable-line no-unused-vars

const TOKEN = 'b'.repeat(43);

beforeEach(() => {
  jest.resetAllMocks();
  prisma.calendarFeed.update.mockResolvedValue({});
  prisma.booking.findMany.mockResolvedValue([]);
});

describe('GET /calendar-feed/:token.ics', () => {
  test('serves a calendar with private, no-referrer, noindex headers', async () => {
    prisma.calendarFeed.findUnique.mockResolvedValue({ id: 'f1', businessId: 'b1', cleanerId: null, userId: 'u1', revokedAt: null, business: { name: 'Schoon' }, cleaner: null });
    prisma.businessMember.findFirst.mockResolvedValue({ id: 'm1' });
    const res = await request(app).get(`/api/v1/calendar-feed/${TOKEN}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/calendar/);
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.text).toContain('BEGIN:VCALENDAR');
  });

  test('an unknown link is a plain 404 that reveals nothing', async () => {
    prisma.calendarFeed.findUnique.mockResolvedValue(null);
    const res = await request(app).get(`/api/v1/calendar-feed/${TOKEN}.ics`);
    expect(res.status).toBe(404);
    expect(res.text).toBe('Not found');
  });

  test('an unexpected failure is not disguised as "not found"', async () => {
    prisma.calendarFeed.findUnique.mockRejectedValue(new Error('db down'));
    const res = await request(app).get(`/api/v1/calendar-feed/${TOKEN}.ics`);
    expect(res.status).toBe(500);
  });
});
