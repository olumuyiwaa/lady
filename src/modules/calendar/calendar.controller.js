const service = require('./calendar.service');
const { success } = require('../../utils/response');

async function listEvents(req, res, next) {
  try {
    const types = req.query.types
      ? String(req.query.types)
          .split(',')
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean)
      : undefined;

    const events = await service.listEvents(req.businessId, {
      from: req.query.from,
      to: req.query.to,
      types,
    });

    return success(res, 200, { events });
  } catch (err) {
    next(err);
  }
}

module.exports = { listEvents };
