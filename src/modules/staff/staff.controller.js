const service = require('./staff.service');
const { success } = require('../../utils/response');

async function list(req, res, next) {
  try {
    const members = await service.listMembers(req.businessId);
    return success(res, 200, members);
  } catch (err) {
    next(err);
  }
}

async function invite(req, res, next) {
  try {
    const member = await service.inviteMember(req.businessId, req.user.id, req.body);
    return success(res, 201, member, 'Invite sent');
  } catch (err) {
    next(err);
  }
}

async function updateRole(req, res, next) {
  try {
    const member = await service.updateMemberRole(req.businessId, req.user.id, req.params.id, req.body.role);
    return success(res, 200, member, 'Role updated');
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await service.removeMember(req.businessId, req.user.id, req.params.id);
    return success(res, 200, null, 'Team member removed');
  } catch (err) {
    next(err);
  }
}

module.exports = { list, invite, updateRole, remove };
