const service = require('./bookings.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const bookings = await service.listBookings(req.businessId, { status: req.query.status }, req.user);
    return success(res, 200, bookings);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const booking = await service.createBooking(req.businessId, req.user.id, req.body);
    return success(res, 201, booking, 'Booking created');
  } catch (err) {
    next(err);
  }
}

async function get(req, res, next) {
  try {
    const booking = await service.getBookingById(req.businessId, req.params.id, req.user);
    return success(res, 200, booking);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const booking = await service.updateBooking(req.businessId, req.params.id, req.body);
    return success(res, 200, booking, 'Booking updated');
  } catch (err) {
    next(err);
  }
}

async function assign(req, res, next) {
  try {
    const assignment = await service.assignBooking(req.businessId, req.params.id, req.body.cleanerId, req.user.id, {
      isTeamLead: req.body.isTeamLead,
      earningsSplitPercent: req.body.earningsSplitPercent,
    });
    return success(res, 200, assignment, 'Booking assigned');
  } catch (err) {
    next(err);
  }
}

async function confirm(req, res, next) {
  try {
    const booking = await service.confirmBooking(req.businessId, req.params.id, req.user.id);
    return success(res, 200, booking, 'Booking confirmed');
  } catch (err) {
    next(err);
  }
}

async function complete(req, res, next) {
  try {
    const booking = await service.completeBooking(req.businessId, req.params.id, req.user.id);
    return success(res, 200, booking, 'Booking completed');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, get, update, assign, confirm, complete };

async function createRecurring(req, res, next) {
  try {
    const r = await service.createRecurringSchedule(req.businessId, req.user.id, req.body);
    return success(res, 201, r, 'Recurring schedule created');
  } catch (err) {
    next(err);
  }
}

async function listRecurring(req, res, next) {
  try {
    const r = await service.listRecurringSchedules(req.businessId);
    return success(res, 200, r);
  } catch (err) {
    next(err);
  }
}

async function cancelRecurring(req, res, next) {
  try {
    await service.cancelRecurringSchedule(req.businessId, req.params.id, req.user.id);
    return success(res, 200, null, 'Recurring schedule canceled');
  } catch (err) {
    next(err);
  }
}

module.exports.createRecurring = createRecurring;
module.exports.listRecurring = listRecurring;
module.exports.cancelRecurring = cancelRecurring;

async function cancel(req, res, next) {
  try {
    const booking = await service.cancelBooking(req.businessId, req.params.id, req.user.id, req.body.reason, {
      waiveFee: !!req.body.waiveFee,
    });
    return success(res, 200, booking, 'Booking cancelled');
  } catch (err) {
    next(err);
  }
}

async function reschedule(req, res, next) {
  try {
    const booking = await service.rescheduleBooking(req.businessId, req.params.id, req.user.id, req.body);
    return success(res, 200, booking, 'Booking rescheduled');
  } catch (err) {
    next(err);
  }
}

async function updatePayment(req, res, next) {
  try {
    const booking = await service.updatePaymentStatus(req.businessId, req.params.id, req.user.id, req.body);
    return success(res, 200, booking, 'Payment status updated');
  } catch (err) {
    next(err);
  }
}



async function markPaymentReceived(req, res, next) {
  try {
    const booking = await service.markPaymentReceived(
        req.businessId,
        req.params.id,
        req.user.id,
        {
          method: req.body?.method,
          reference: req.body?.reference,
          amountCents: req.body?.amountCents,
          note: req.body?.note,
        }
    );
    return success(res, 200, booking, 'Payment marked as received');
  } catch (err) {
    next(err);
  }
}

module.exports.cancel = cancel;
module.exports.reschedule = reschedule;
module.exports.updatePayment = updatePayment;
module.exports.markPaymentReceived = markPaymentReceived;

async function createPaymentLink(req, res, next) {
  try {
    const result = await service.createPaymentLink(req.businessId, req.params.id, req.user.id, req.body);
    return success(res, 200, result, 'Payment link created');
  } catch (err) {
    next(err);
  }
}

module.exports.createPaymentLink = createPaymentLink;

async function pauseRecurring(req, res, next) {
  try {
    const data = await service.pauseRecurringSchedule(req.businessId, req.params.id, req.user.id);
    return success(res, 200, data, 'Recurring schedule paused');
  } catch (err) { next(err); }
}
async function resumeRecurring(req, res, next) {
  try {
    const data = await service.resumeRecurringSchedule(req.businessId, req.params.id, req.user.id);
    return success(res, 200, data, 'Recurring schedule resumed');
  } catch (err) { next(err); }
}
module.exports.pauseRecurring = pauseRecurring;
module.exports.resumeRecurring = resumeRecurring;
