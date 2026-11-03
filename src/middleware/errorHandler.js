const logger = require('../config/logger');
const { error } = require('../utils/response');

function errorHandler(err, req, res, next) {
  logger.error(err.message, { stack: err.stack, path: req.path, businessId: req.businessId });

  if (err.code === 'P2002') return error(res, 409, `Duplicate value for ${err.meta?.target}`);
  if (err.code === 'P2025') return error(res, 404, 'Record not found');
  if (err.type === 'entity.parse.failed') return error(res, 400, 'Malformed JSON body');
  // zod's .parse() (used by the inventory/compliance validation schemas,
  // unlike the express-validator middleware chains everything else uses)
  // throws a ZodError with no .status, so without this it fell through to
  // the generic 500 branch below -- every validation mistake on those
  // endpoints (a missing required field, a bad enum value) looked like a
  // server crash instead of a 422 with the actual field-level problem.
  if (err.name === 'ZodError') return error(res, 422, 'Validation failed', err.issues);

  const status = err.status || 500;
  const message = status === 500 ? 'Internal server error' : err.message;
  return error(res, status, message, err.errors || null);
}

module.exports = errorHandler;