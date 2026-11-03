const express = require('express');
const cron = require('node-cron');
const logger = require('../config/logger');
const { processOnce } = require('./recurringWorker');
const { sweepUnpaidDeposits } = require('./depositSweeper');

const PORT = parseInt(process.env.RECURRING_DAEMON_PORT || '4001', 10);
const CRON_EXPR = process.env.RECURRING_CRON || '*/5 * * * *'; // default every 5 minutes

const status = {
  lastRun: null,
  processedSchedules: 0,
  createdBookings: 0,
  errors: 0,
  lastError: null,
};

async function runIteration() {
  status.lastRun = new Date();
  try {
    // processOnce does the heavy lifting; we wrap to collect some basic metrics
    await processOnce();
    status.processedSchedules += 1;
    // Same cadence: release slots held by deposits that were never paid.
    await sweepUnpaidDeposits();
  } catch (e) {
    status.errors += 1;
    status.lastError = e.message;
    logger.error('recurringDaemon error', e);
  }
}

async function start() {
  const app = express();

  app.get('/status', (req, res) => {
    res.json(status);
  });

  app.listen(PORT, () => logger.info(`recurring daemon status listening on ${PORT}`));

  logger.info('recurring daemon starting', { cron: CRON_EXPR });
  cron.schedule(CRON_EXPR, () => {
    logger.info('recurring daemon tick');
    runIteration();
  });

  // run one immediately on start
  runIteration();
}

start().catch((e) => {
  logger.error('recurring daemon failed to start', e);
  process.exit(1);
});
