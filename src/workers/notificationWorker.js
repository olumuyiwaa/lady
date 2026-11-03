const { notificationQueue } = require('../lib/queue');
const logger = require('../config/logger');
const notificationClient = require('../lib/notificationClient');

async function start() {
  logger.info('Starting notification worker');

  notificationQueue.process('email', 5, async (job) => {
    const payload = job.data;
    logger.info('Processing email job', { id: job.id, data: payload });
    return notificationClient._sendEmailNow(payload);
  });

  notificationQueue.process('sms', 10, async (job) => {
    const payload = job.data;
    logger.info('Processing sms job', { id: job.id, data: payload });
    return notificationClient._sendSmsNow(payload);
  });

  notificationQueue.on('completed', (job) => {
    logger.info('notification job completed', { id: job.id, name: job.name });
  });

  notificationQueue.on('failed', (job, err) => {
    logger.error('notification job failed', { id: job.id, name: job.name, attemptsMade: job.attemptsMade, err: err && err.message });
    try {
      const max = (job.opts && job.opts.attempts) || 0;
      if (job.attemptsMade >= max && process.env.ADMIN_EMAIL) {
        const subject = `Notification job failed: ${job.name}`;
        const text = `Job ${job.id} (${job.name}) failed after ${job.attemptsMade} attempts. Error: ${err && err.message}\nData: ${JSON.stringify(job.data)}`;
        notificationClient._sendEmailNow({ to: process.env.ADMIN_EMAIL, subject, text });
      }
    } catch (e) {
      logger.error('failed to send admin alert for notification failure', e);
    }
  });

  process.on('SIGINT', async () => {
    logger.info('Shutting down notification worker');
    await notificationQueue.close();
    process.exit(0);
  });
}

start().catch((e) => {
  logger.error('notification worker failed to start', e);
  process.exit(1);
});
