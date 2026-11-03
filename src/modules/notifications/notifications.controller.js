const service = require('./notifications.service');
const { success } = require('../../utils/response');
const { notificationQueue } = require('../../lib/queue');
const logger = require('../../config/logger');

async function list(req, res, next) {
  try {
    const notifications = await service.listForBusiness(req.businessId, req.user.id);
    return success(res, 200, notifications);
  } catch (err) {
    next(err);
  }
}

module.exports = { list };

async function failedJobs(req, res, next) {
  try {
    const jobs = await notificationQueue.getFailed();
    // return a lightweight view
    const data = jobs.map((j) => ({ id: j.id, name: j.name, failedAt: j.finishedOn || null, attemptsMade: j.attemptsMade, data: j.data }));
    return success(res, 200, data);
  } catch (err) {
    logger.error('failed to list failed jobs', err);
    next(err);
  }
}

module.exports.failedJobs = failedJobs;
