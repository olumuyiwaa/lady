'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('./inventory.controller');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

// Previously mounted with no auth or tenant-scoping middleware at all.
// getBusinessId() in the controller read req.business?.id / req.user?.businessId,
// neither of which anything ever set on this router, so businessId was
// always undefined — and `where: { businessId: undefined }` is not a
// filter to Prisma, it's the same as no filter. Every /inventory endpoint
// was reachable with no login and returned every business's inventory
// data. This line is the actual fix; everything else in this module is
// secondary to closing this.
router.use(authenticate, scopeToBusiness, requireRole('BUSINESS_OWNER', 'BUSINESS_MANAGER'));

// ─── Items ────────────────────────────────────────────────
router.get('/items', ctrl.listItems);
router.get('/items/:id', ctrl.getItem);
router.post('/items', ctrl.createItem);
router.patch('/items/:id', ctrl.updateItem);

// ─── Locations ────────────────────────────────────────────
router.get('/locations', ctrl.listLocations);
router.post('/locations', ctrl.createLocation);
router.patch('/locations/:id', ctrl.updateLocation);

// ─── Stock ────────────────────────────────────────────────
router.get('/stock', ctrl.getStock);

// ─── Movements ────────────────────────────────────────────
router.post('/movements', ctrl.createMovement);

// ─── Job usage (also mount under bookings if preferred) ───
router.post('/bookings/:bookingId/usage', ctrl.recordJobUsage);

module.exports = router;
