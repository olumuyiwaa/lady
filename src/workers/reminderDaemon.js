const cron = require('node-cron');
const { sendReminders } = require('./sendReminders');
const logger = require('../config/logger');

// Run every hour by default; configurable via CRON_SCHEDULE
const schedule = process.env.REMINDER_CRON || '0 * * * *';

logger.info(`Starting reminder daemon with schedule: ${schedule}`);
cron.schedule(schedule, async () => {
  try {
    await sendReminders();
  } catch (e) {
    logger.error('reminder job failed', e);
  }
});
