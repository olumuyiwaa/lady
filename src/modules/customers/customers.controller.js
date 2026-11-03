const service = require('./customers.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const customers = await service.listCustomers(req.businessId, { q: req.query.q, take: req.query.take });
    return success(res, 200, customers);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const customer = await service.createCustomer(req.businessId, req.user.id, req.body);
    return success(res, 201, customer, 'Customer created');
  } catch (err) {
    next(err);
  }
}

async function get(req, res, next) {
  try {
    const customer = await service.getCustomer(req.businessId, req.params.id);
    return success(res, 200, customer);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const customer = await service.updateCustomer(req.businessId, req.params.id, req.user.id, req.body);
    return success(res, 200, customer, 'Customer updated');
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.deleteCustomer(req.businessId, req.params.id, req.user.id);
    return success(res, 200, null, 'Customer deleted');
  } catch (err) {
    next(err);
  }
}

async function addAddress(req, res, next) {
  try {
    const address = await service.addAddress(req.businessId, req.params.id, req.user.id, req.body);
    return success(res, 201, address, 'Address added');
  } catch (err) {
    next(err);
  }
}

async function updateAddress(req, res, next) {
  try {
    const address = await service.updateAddress(req.businessId, req.params.id, req.params.addressId, req.user.id, req.body);
    return success(res, 200, address, 'Address updated');
  } catch (err) {
    next(err);
  }
}

async function deleteAddress(req, res, next) {
  try {
    await service.deleteAddress(req.businessId, req.params.id, req.params.addressId, req.user.id);
    return success(res, 200, null, 'Address deleted');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, get, update, remove, addAddress, updateAddress, deleteAddress };
