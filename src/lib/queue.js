const Queue = require('bull');

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Notifications queue with reasonable defaults
const notificationQueue = new Queue('notifications', redisUrl, {
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

module.exports = { notificationQueue };
