const prisma = require('../config/database');
const notifications = require('../modules/notifications/notifications.service');
const logger = require('../config/logger');

// Sends a ONE-TIME reminder for bookings scheduled within the next
// `HOURS_AHEAD` hours. Guarded by Booking.reminderSentAt so a booking that
// stays inside the lookahead window across multiple worker runs (this runs
// hourly) only gets reminded once, instead of the original "booking
// requested" notification being re-sent every run.
async function sendReminders() {
  const HOURS_AHEAD = parseInt(process.env.REMINDER_HOURS_AHEAD || '24', 10);
  const now = new Date();
  const upper = new Date(now.getTime() + HOURS_AHEAD * 60 * 60 * 1000);

  const bookings = await prisma.booking.findMany({
    where: {
      scheduledStart: { gte: now, lt: upper },
      // ASSIGNED was missing: once a cleaner was dispatched the customer never got a reminder.
      status: { in: ['REQUESTED', 'CONFIRMED', 'ASSIGNED'] },
      reminderSentAt: null,
    },
    include: { customer: true, service: true },
  });

  logger.info(`Found ${bookings.length} bookings to remind`);

  for (const b of bookings) {
    try {
      // Atomic claim: only proceed if this row still has no reminderSentAt.
      // If two worker instances race on the same booking, only one of the
      // two updateMany calls will match a row and return count 1.
      const claim = await prisma.booking.updateMany({
        where: { id: b.id, reminderSentAt: null },
        data: { reminderSentAt: new Date() },
      });
      if (claim.count === 0) continue; // another run already claimed it

      await notifications.sendBookingReminder(b.businessId, b, b.customer);
    } catch (e) {
      logger.error('failed to send reminder for booking', b.id, e);
    }
  }
}

if (require.main === module) {
  sendReminders()
      .then(() => {
        logger.info('sendReminders finished');
        process.exit(0);
      })
      .catch((err) => {
        logger.error('sendReminders failed', err);
        process.exit(1);
      });
}

module.exports = { sendReminders };