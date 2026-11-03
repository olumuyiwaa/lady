const express = require('express');
const controller = require('./checklists.controller');
const { authenticate } = require('../../middleware/authenticate');
const { scopeToBusiness } = require('../../middleware/scopeToBusiness');

const router = express.Router();

router.use(authenticate, scopeToBusiness);

router.get('/', controller.list);

router.post('/', controller.create);
router.get('/:bookingId', controller.get);
router.put('/:bookingId', controller.update);
router.delete('/:bookingId', controller.remove);
router.post('/:bookingId/items/:itemId/complete', controller.completeItem);

module.exports = router;
