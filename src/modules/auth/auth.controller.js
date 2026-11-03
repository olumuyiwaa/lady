const authService = require('./auth.service');
const { success, error } = require('../../utils/response');

async function register(req, res) {
  // The one business and its owner are created by `npm run seed`.
  return error(res, 404, 'Registration is not available');
}

async function login(req, res, next) {
  try {
    const result = await authService.login({
      ...req.body,
      twoFactorCode: req.body.twoFactorCode,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    if (result.requiresBusinessSelection) {
      // Credentials were correct, but this account is affiliated with more
      // than one business. Client should present `affiliations` and re-submit
      // login with a `businessId`.
      return success(res, 200, result, 'Select a business to continue');
    }
    return success(res, 200, result, 'Logged in');
  } catch (err) {
    next(err);
  }
}

/** Switch the active business workspace for an already-authenticated user. */
async function selectBusiness(req, res, next) {
  try {
    const tokens = await authService.selectBusiness(req.user.id, req.body.businessId, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    return success(res, 200, tokens, 'Switched business');
  } catch (err) {
    next(err);
  }
}

/** Lists every business (as staff or cleaner) the current user can switch into. */
async function affiliations(req, res, next) {
  try {
    const list = await authService.listAffiliations(req.user.id);
    return success(res, 200, list);
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return error(res, 400, 'refreshToken is required');
    const tokens = await authService.refresh(refreshToken);
    return success(res, 200, tokens, 'Token refreshed');
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    await authService.logout(req.body.refreshToken);
    return success(res, 200, null, 'Logged out');
  } catch (err) {
    next(err);
  }
}

async function requestPasswordReset(req, res, next) {
  try {
    await authService.requestPasswordReset(req.body.email);
    return success(res, 200, null, 'If an account exists, a reset email was sent');
  } catch (err) {
    next(err);
  }
}

async function confirmPasswordReset(req, res, next) {
  try {
    await authService.confirmPasswordReset(req.body.token, req.body.password);
    return success(res, 200, null, 'Password reset');
  } catch (err) {
    next(err);
  }
}

async function requestEmailVerify(req, res, next) {
  try {
    await authService.requestEmailVerify(req.user.id);
    return success(res, 200, null, 'Verification email sent');
  } catch (err) {
    next(err);
  }
}

async function confirmEmailVerify(req, res, next) {
  try {
    await authService.confirmEmailVerify(req.user.id, req.body.code);
    return success(res, 200, null, 'Email verified');
  } catch (err) {
    next(err);
  }
}

async function generate2FA(req, res, next) {
  try {
    const secret = await authService.generate2FASecret(req.user.id);
    return success(res, 200, secret);
  } catch (err) {
    next(err);
  }
}

async function verifyEnable2FA(req, res, next) {
  try {
    await authService.verifyAndEnable2FA(req.user.id, req.body.token);
    return success(res, 200, null, '2FA enabled');
  } catch (err) {
    next(err);
  }
}

async function disable2FA(req, res, next) {
  try {
    await authService.disable2FA(req.user.id, { password: req.body.password, code: req.body.code });
    return success(res, 200, null, '2FA disabled');
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await authService.getCurrentUser(req.user);
    return success(res, 200, user);
  } catch (err) {
    next(err);
  }
}

async function updateMe(req, res, next) {
  try {
    await authService.updateCurrentUser(req.user.id, req.body);
    const full = await authService.getCurrentUser({
      id: req.user.id,
      globalRole: req.user.globalRole,
      businessId: req.user.businessId,
      businessRole: req.user.businessRole,
    });
    return success(res, 200, full, 'Profile updated');
  } catch (err) {
    next(err);
  }
}

async function changePassword(req, res, next) {
  try {
    await authService.changePassword(req.user.id, req.body);
    return success(res, 200, null, 'Password changed. Please sign in again.');
  } catch (err) {
    next(err);
  }
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  requestPasswordReset,
  confirmPasswordReset,
  requestEmailVerify,
  confirmEmailVerify,
  generate2FA,
  verifyEnable2FA,
  disable2FA,
  me,
  updateMe,
  changePassword,
  selectBusiness,
  affiliations,
};
