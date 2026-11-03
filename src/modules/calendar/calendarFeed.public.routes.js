const express = require('express');
const rateLimit = require('express-rate-limit');
const controller = require('./calendarFeed.controller');

const router = express.Router();

// Calendar apps poll roughly hourly, often from shared provider IPs, so the
// per-IP limit is generous; the per-link limit is what stops hammering. Guessing
// a 256-bit token is not realistic: these limits only bound wasted work.
const perIp = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
const perLink = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.params.file || '').slice(0, 64),
});

router.get('/:file', perIp, perLink, controller.serve);

module.exports = router;
