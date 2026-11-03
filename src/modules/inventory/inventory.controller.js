'use strict';

const inventoryService = require('./inventory.service');
const { success, error } = require('../../utils/response');
const {
  createItemSchema,
  updateItemSchema,
  createLocationSchema,
  updateLocationSchema,
  createMovementSchema,
  jobUsageSchema,
} = require('./inventory.validation');

// req.businessId is set by scopeToBusiness (see inventory.routes.js) once
// it has verified the caller actually belongs to that business — this
// used to read req.business?.id / req.user?.businessId, neither of which
// anything set, so it always resolved to undefined.
function getBusinessId(req) {
  return req.businessId;
}

async function listItems(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const result = await inventoryService.listItems(businessId, {
      type: req.query.type,
      isActive: req.query.isActive === 'true' ? true : req.query.isActive === 'false' ? false : undefined,
      search: req.query.search,
      page: Number(req.query.page) || 1,
      limit: Math.min(Number(req.query.limit) || 50, 100),
    });
    return success(res, 200, result);
  } catch (err) {
    next(err);
  }
}

async function getItem(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const item = await inventoryService.getItem(businessId, req.params.id);
    if (!item) return error(res, 404, 'Item not found');
    return success(res, 200, item);
  } catch (err) {
    next(err);
  }
}

async function createItem(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = createItemSchema.parse(req.body);
    const item = await inventoryService.createItem(businessId, data);
    return success(res, 201, item);
  } catch (err) {
    next(err);
  }
}

async function updateItem(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = updateItemSchema.parse(req.body);
    const item = await inventoryService.updateItem(businessId, req.params.id, data);
    return success(res, 200, item);
  } catch (err) {
    next(err);
  }
}

async function listLocations(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const locations = await inventoryService.listLocations(businessId);
    return success(res, 200, locations);
  } catch (err) {
    next(err);
  }
}

async function createLocation(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = createLocationSchema.parse(req.body);
    const location = await inventoryService.createLocation(businessId, data);
    return success(res, 201, location);
  } catch (err) {
    next(err);
  }
}

async function updateLocation(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = updateLocationSchema.parse(req.body);
    const location = await inventoryService.updateLocation(businessId, req.params.id, data);
    return success(res, 200, location);
  } catch (err) {
    next(err);
  }
}

async function getStock(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const stock = await inventoryService.getStock(businessId, {
      locationId: req.query.locationId,
      lowStockOnly: req.query.lowStock === 'true',
    });
    return success(res, 200, stock);
  } catch (err) {
    next(err);
  }
}

async function createMovement(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = createMovementSchema.parse(req.body);
    const movement = await inventoryService.createMovement(
      businessId,
      data,
      req.user?.id
    );
    return success(res, 201, movement);
  } catch (err) {
    next(err);
  }
}

async function recordJobUsage(req, res, next) {
  try {
    const businessId = getBusinessId(req);
    const data = jobUsageSchema.parse(req.body);
    const usage = await inventoryService.recordJobUsage(
      businessId,
      req.params.bookingId,
      data,
      req.user?.id
    );
    return success(res, 201, usage);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listItems,
  getItem,
  createItem,
  updateItem,
  listLocations,
  createLocation,
  updateLocation,
  getStock,
  createMovement,
  recordJobUsage,
};
