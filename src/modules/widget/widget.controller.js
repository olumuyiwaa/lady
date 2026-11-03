const service = require('./widget.service');
const { success } = require('../../utils/response');

async function storefront(req, res, next) {
  try {
    const data = await service.getStorefront(req.businessId);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

/**
 * Booking-form autofill: postcode + house number -> street, city, coordinates.
 * "No match" is a normal answer (200, found: false), not an error, so the form
 * can quietly leave the fields for the customer to type.
 */
async function addressLookup(req, res, next) {
  try {
    const { lookupNlAddress } = require('../../lib/geocode');
    const address = await lookupNlAddress({
      postalCode: req.query.postalCode,
      houseNumber: req.query.houseNumber,
    });
    return success(res, 200, address ? { found: true, ...address } : { found: false });
  } catch (err) {
    next(err);
  }
}

async function serviceArea(req, res, next) {
  try {
    const data = await service.checkServiceArea(req.businessId, { postalCode: req.query.postalCode });
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function quote(req, res, next) {
  try {
    const data = await service.quote(req.businessId, req.body);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function slots(req, res, next) {
  try {
    const data = await service.slots(req.businessId, req.query);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function submitBooking(req, res, next) {
  try {
    const booking = await service.submitBooking(req.businessId, req.body);
    return success(res, 201, booking, 'Booking request received');
  } catch (err) {
    next(err);
  }
}

async function giftCardBalance(req, res, next) {
  try {
    const data = await service.checkGiftCardBalance(req.businessId, req.params.code);
    return success(res, 200, data);
  } catch (err) {
    next(err);
  }
}

async function joinWaitlist(req, res, next) {
  try {
    const waitlistService = require('../waitlist/waitlist.service');
    const entry = await waitlistService.joinWaitlist(req.businessId, req.body);
    return success(res, 201, entry, "You're on the waitlist — we'll reach out the moment a slot opens up");
  } catch (err) {
    next(err);
  }
}

async function contact(req, res, next) {
  try {
    // Honeypot filled in => a bot. Answer like a success so it learns nothing,
    // but store and send nothing.
    if (req.body.website) {
      const fake = Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, 'X');
      return success(res, 201, { reference: `T-${fake}` }, 'Message received');
    }
    const supportTickets = require('../supportTickets/supportTickets.service');
    const data = await supportTickets.createWebsiteTicket(req.business, req.body);
    return success(res, 201, data, 'Message received');
  } catch (err) {
    next(err);
  }
}

module.exports = { storefront, addressLookup, serviceArea, quote, slots, submitBooking, giftCardBalance, joinWaitlist, contact };