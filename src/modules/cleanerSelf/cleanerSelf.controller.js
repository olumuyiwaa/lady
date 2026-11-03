const service = require('./cleanerSelf.service');
const payrollService = require('../payroll/payroll.service');
const { success } = require('../../utils/response');

async function getEarnings(req, res, next) {
  try {
    const summary = await payrollService.getEarningsSummaryByCleanerId(req.businessId, req.cleaner.id);
    return success(res, 200, summary);
  } catch (err) {
    next(err);
  }
}

async function getProfile(req, res, next) {
  try {
    const profile = await service.getMyProfile(req.cleaner);
    return success(res, 200, profile);
  } catch (err) {
    next(err);
  }
}

async function updateProfile(req, res, next) {
  try {
    const profile = await service.updateMyProfile(req.cleaner, req.body);
    return success(res, 200, profile, 'Profile updated');
  } catch (err) {
    next(err);
  }
}

async function avatarUploadUrl(req, res, next) {
  try {
    const result = await service.getMyAvatarUploadUrl(req.cleaner, req.body);
    return success(res, 200, result);
  } catch (err) {
    next(err);
  }
}

async function getAvailability(req, res, next) {
  try {
    const slots = await service.getMyAvailability(req.cleaner);
    return success(res, 200, slots);
  } catch (err) {
    next(err);
  }
}

async function updateAvailability(req, res, next) {
  try {
    const slots = await service.updateMyAvailability(req.cleaner, req.body.slots);
    return success(res, 200, slots, 'Availability updated');
  } catch (err) {
    next(err);
  }
}

async function listDocuments(req, res, next) {
  try {
    const docs = await service.listMyDocuments(req.cleaner);
    return success(res, 200, docs);
  } catch (err) {
    next(err);
  }
}

async function documentUploadUrl(req, res, next) {
  try {
    const result = await service.getMyDocumentUploadUrl(req.cleaner, req.body);
    return success(res, 200, result);
  } catch (err) {
    next(err);
  }
}

async function createDocument(req, res, next) {
  try {
    const doc = await service.createMyDocument(req.cleaner, req.body);
    return success(res, 201, doc, 'Document uploaded');
  } catch (err) {
    next(err);
  }
}

async function documentDownloadUrl(req, res, next) {
  try {
    const result = await service.getMyDocumentDownloadUrl(req.cleaner, req.params.id);
    return success(res, 200, result);
  } catch (err) {
    next(err);
  }
}

async function registerDeviceToken(req, res, next) {
  try {
    await service.registerDeviceToken(req.cleaner, req.body);
    return success(res, 200, { registered: true });
  } catch (err) {
    next(err);
  }
}

async function unregisterDeviceToken(req, res, next) {
  try {
    await service.unregisterDeviceToken(req.cleaner, req.body.token);
    return success(res, 200, { registered: false });
  } catch (err) {
    next(err);
  }
}

async function getStripeOnboardingLink(req, res, next) {
  try {
    const result = await service.getStripeOnboardingLink(req.cleaner, req.body || {});
    return success(res, 200, result);
  } catch (err) {
    next(err);
  }
}

async function getStripeStatus(req, res, next) {
  try {
    const status = await service.getStripeStatus(req.cleaner);
    return success(res, 200, status);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getProfile,
  updateProfile,
  avatarUploadUrl,
  getAvailability,
  updateAvailability,
  listDocuments,
  documentUploadUrl,
  createDocument,
  documentDownloadUrl,
  registerDeviceToken,
  unregisterDeviceToken,
  getEarnings,
  getStripeOnboardingLink,
  getStripeStatus,
};
