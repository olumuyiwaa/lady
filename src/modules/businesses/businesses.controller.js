const service = require('./businesses.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const businesses = await service.listBusinesses(req.businessId);
    return success(res, 200, businesses);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const b = await service.updateBusiness(req.businessId, req.body);
    return success(res, 200, b, 'Business updated');
  } catch (err) {
    next(err);
  }
}
async function getBranding(req, res, next) {
  try {
    const b = await service.getBranding(req.businessId);
    return success(res, 200, b);
  } catch (err) {
    next(err);
  }
}

async function getStripeConnectStatus(req, res, next) {
  try {
    const s = await service.getStripeConnectStatus(req.businessId);
    return success(res, 200, s);
  } catch (err) {
    next(err);
  }
}

async function startStripeConnectOnboarding(req, res, next) {
  try {
    const s = await service.startStripeConnectOnboarding(req.businessId, req.body || {});
    return success(res, 200, s);
  } catch (err) {
    next(err);
  }
}

async function refreshStripeConnectStatus(req, res, next) {
  try {
    const s = await service.refreshStripeConnectStatus(req.businessId);
    return success(res, 200, s, 'Stripe Connect status refreshed');
  } catch (err) {
    next(err);
  }
}

async function updateBranding(req, res, next) {
  try {
    const b = await service.updateBranding(req.businessId, req.body);
    return success(res, 200, b, 'Branding updated');
  } catch (err) {
    next(err);
  }
}

async function brandingUploadUrl(req, res, next) {
  try {
    const result = await service.brandingUploadUrl(req.businessId, req.body);
    return success(res, 200, result);
  } catch (err) {
    next(err);
  }
}

async function addAddress(req, res, next) {
  try {
    const a = await service.addAddress(req.businessId, req.body);
    return success(res, 201, a, 'Address added');
  } catch (err) {
    next(err);
  }
}

async function updateAddress(req, res, next) {
  try {
    const a = await service.updateAddress(req.businessId, req.params.id, req.body);
    return success(res, 200, a, 'Address updated');
  } catch (err) {
    next(err);
  }
}

async function removeAddress(req, res, next) {
  try {
    await service.removeAddress(req.businessId, req.params.id);
    return success(res, 200, null, 'Address removed');
  } catch (err) {
    next(err);
  }
}

async function listServiceAreas(req, res, next) {
  try {
    const s = await service.listServiceAreas(req.businessId);
    return success(res, 200, s);
  } catch (err) {
    next(err);
  }
}

async function createServiceArea(req, res, next) {
  try {
    const s = await service.createServiceArea(req.businessId, req.body);
    return success(res, 201, s, 'Service area created');
  } catch (err) {
    next(err);
  }
}

async function updateServiceArea(req, res, next) {
  try {
    const s = await service.updateServiceArea(req.businessId, req.params.id, req.body);
    return success(res, 200, s, 'Service area updated');
  } catch (err) {
    next(err);
  }
}

async function deleteServiceArea(req, res, next) {
  try {
    await service.deleteServiceArea(req.businessId, req.params.id);
    return success(res, 200, null, 'Service area deleted');
  } catch (err) {
    next(err);
  }
}

async function listHours(req, res, next) {
  try {
    const h = await service.listHours(req.businessId);
    return success(res, 200, h);
  } catch (err) {
    next(err);
  }
}

async function updateHours(req, res, next) {
  try {
    const h = await service.updateHours(req.businessId, req.body.hours || []);
    return success(res, 200, h, 'Hours updated');
  } catch (err) {
    next(err);
  }
}


async function listLocations(req, res, next) {
  try {
    const locations = await service.listLocations(req.businessId);
    return success(res, 200, locations);
  } catch (err) {
    next(err);
  }
}

async function createLocation(req, res, next) {
  try {
    const location = await service.createLocation(req.businessId, req.user.id, req.body);
    return success(res, 201, location, 'Location created');
  } catch (err) {
    next(err);
  }
}

async function getOnboardingStatus(req, res, next) {
  try {
    const s = await service.getOnboardingStatus(req.businessId);
    return success(res, 200, s);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, update, getBranding, updateBranding, brandingUploadUrl, addAddress, updateAddress, removeAddress, listServiceAreas, createServiceArea, updateServiceArea, deleteServiceArea, listHours, updateHours, getStripeConnectStatus, startStripeConnectOnboarding, refreshStripeConnectStatus, listLocations, createLocation, getOnboardingStatus };
