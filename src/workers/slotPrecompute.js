/**
 * Precompute daily slots for all businesses and services and cache in Redis.
 * Run once per day (cron) to warm the slot cache used by the widget.
 */
const prisma = require('../config/database');
const scheduler = require('../lib/scheduler');
const cache = require('../lib/cache');

async function computeForDate(date) {
  const businesses = await prisma.business.findMany({ where: { isActive: true }, select: { id: true } });
  for (const b of businesses) {
    const services = await prisma.service.findMany({ where: { businessId: b.id, isActive: true } });
    for (const s of services) {
      try {
        const dayStr = date.toISOString().slice(0,10);
        const redisKey = `slots:${b.id}:${s.id}:${dayStr}:${s.estimatedMinutes || 60}`;
        // replicate widget.slot logic but cheaper: use businessHours and scheduler in batch
        const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const businessHours = await prisma.businessHours.findMany({ where: { businessId: b.id, dayOfWeek: day.getDay() } });
        const slotLen = s.estimatedMinutes || 60;
        const slots = [];
        for (const h of businessHours) {
          const startParts = h.openTime.split(':').map(Number);
          const endParts = h.closeTime.split(':').map(Number);
          const startDt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startParts[0], startParts[1] || 0);
          const endDt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), endParts[0], endParts[1] || 0);
          for (let t = new Date(startDt); t.getTime() + slotLen * 60000 <= endDt.getTime(); t.setMinutes(t.getMinutes() + 30)) {
            const slotStart = new Date(t);
            const slotEnd = new Date(t.getTime() + slotLen * 60000);
            // don't pass lat/lng to scheduler here to favour availability-only checks
            const candidates = await scheduler.findAvailableCleaners(b.id, slotStart, slotEnd, {});
            if (candidates && candidates.length > 0) {
              slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString(), available: candidates.length });
            }
          }
        }
        await cache.set(redisKey, slots, 24 * 60 * 60);
        console.log('Warmed', redisKey, '->', slots.length, 'slots');
      } catch (e) {
        console.error('Error precomputing for', b.id, s.id, e && e.message);
      }
    }
  }
}

async function main() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  await computeForDate(tomorrow);
  process.exit(0);
}

if (require.main === module) {
  main();
}
