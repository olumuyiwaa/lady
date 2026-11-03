const express = require('express');
const controller = require('./calendar.controller');
const feeds = require('./calendarFeed.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/events', requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'), controller.listEvents);

// Subscription links for external calendar apps. Cleaners manage only their own.
const feedRoles = requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER', 'CLEANER');
router.get('/feeds', feedRoles, feeds.list);
router.post('/feeds', feedRoles, feeds.create);
router.delete('/feeds/:id', feedRoles, feeds.revoke);

module.exports = router;
