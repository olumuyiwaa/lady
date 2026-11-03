const service = require('./cleaners.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const cleaners = await service.listCleaners(req.businessId, { status: req.query.status });
    return success(res, 200, cleaners);
  } catch (err) {
    next(err);
  }
}

async function onboard(req, res, next) {
  try {
    const profile = await service.onboardCleaner(req.businessId, req.user.id, req.body);
    return success(res, 201, profile, 'Cleaner onboarded');
  } catch (err) {
    next(err);
  }
}

async function suspend(req, res, next) {
  try {
    const profile = await service.suspendCleaner(req.businessId, req.user.id, req.params.id, req.body.reason);
    return success(res, 200, profile, 'Cleaner suspended');
  } catch (err) {
    next(err);
  }
}

async function reactivate(req, res, next) {
  try {
    const profile = await service.reactivateCleaner(req.businessId, req.user.id, req.params.id);
    return success(res, 200, profile, 'Cleaner reactivated');
  } catch (err) {
    next(err);
  }
}

async function upcomingJobs(req, res, next) {
  try {
    const jobs = await service.listUpcomingJobs(req.businessId, req.params.id);
    return success(res, 200, jobs);
  } catch (err) {
    next(err);
  }
}

async function offboard(req, res, next) {
  try {
    const profile = await service.offboardCleaner(req.businessId, req.user.id, req.params.id, req.body.reason);
    return success(res, 200, profile, 'Cleaner offboarded');
  } catch (err) {
    next(err);
  }
}

async function updateAvailability(req, res, next) {
  try {
    const availability = await service.setAvailability(req.businessId, req.params.id, req.body.slots);
    return success(res, 200, availability, 'Availability updated');
  } catch (err) {
    next(err);
  }
}

async function clockIn(req, res, next) {
  try {
    const result = await service.clockIn(req.businessId, req.params.id, req.body.assignmentId, req.user.id, { lat: req.body.lat, lng: req.body.lng });
    return success(res, 200, result, 'Checked in');
  } catch (err) {
    next(err);
  }
}

async function clockOut(req, res, next) {
  try {
    const result = await service.clockOut(req.businessId, req.params.id, req.body.assignmentId, req.user.id, { lat: req.body.lat, lng: req.body.lng });
    return success(res, 200, result, 'Checked out');
  } catch (err) {
    next(err);
  }
}


async function performance(req, res, next) {
  try {
    const data = await service.getCleanerPerformance(req.businessId, req.params.id, {
      from: req.query.from,
      to: req.query.to,
    });
    if (!data) return success(res, 200, { cleanerId: req.params.id, jobs: 0, completed: 0, revenueCents: 0, avgRating: null, reviewCount: 0, lowRatingCount: 0 });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

module.exports = { list, onboard, offboard, suspend, reactivate, upcomingJobs, updateAvailability, clockIn, clockOut, performance };
