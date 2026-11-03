const express = require('express');
const { body } = require('express-validator');
const controller = require('./auth.controller');
const validate = require('../../middleware/validate');
const {
    authLimiter,
    loginLimiter,
    passwordResetLimiter,
    refreshLimiter,
    sensitiveActionLimiter,
} = require('../../middleware/rateLimiter');
const { authenticate } = require('../../middleware/authenticate');

const router = express.Router();

// Registration is not available — the single business and its owner are
// created by `npm run seed`. Expose a clear 404 so scanners don't assume
// a working signup surface.
router.post('/register', authLimiter, (req, res) =>
    res.status(404).json({ success: false, message: 'Registration is not available' })
);

router.post(
    '/login',
    authLimiter,
    loginLimiter,
    [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
    validate,
    controller.login
);

router.post('/refresh', refreshLimiter, [body('refreshToken').notEmpty()], validate, controller.refresh);
router.post('/logout', [body('refreshToken').notEmpty()], validate, controller.logout);

router.post(
    '/password-reset/request',
    passwordResetLimiter,
    [body('email').isEmail().normalizeEmail()],
    validate,
    controller.requestPasswordReset
);
router.post(
    '/password-reset/confirm',
    authLimiter,
    [body('token').notEmpty(), body('password').isLength({ min: 8 })],
    validate,
    controller.confirmPasswordReset
);

router.post('/email/verify/request', authenticate, sensitiveActionLimiter, controller.requestEmailVerify);
router.post(
    '/email/verify/confirm',
    authenticate,
    sensitiveActionLimiter,
    [body('code').notEmpty()],
    validate,
    controller.confirmEmailVerify
);

router.post('/2fa/generate', authenticate, sensitiveActionLimiter, controller.generate2FA);
router.post(
    '/2fa/verify-enable',
    authenticate,
    sensitiveActionLimiter,
    [body('token').notEmpty()],
    validate,
    controller.verifyEnable2FA
);
router.post(
    '/2fa/disable',
    authenticate,
    sensitiveActionLimiter,
    [body('password').notEmpty(), body('code').notEmpty()],
    validate,
    controller.disable2FA
);

router.get('/me', authenticate, controller.me);
router.patch(
    '/me',
    authenticate,
    [
        body('firstName').optional().trim().notEmpty(),
        body('lastName').optional().trim().notEmpty(),
        body('phone').optional({ nullable: true }),
    ],
    validate,
    controller.updateMe
);
router.patch(
    '/me/password',
    authenticate,
    [body('currentPassword').notEmpty(), body('newPassword').isLength({ min: 8 })],
    validate,
    controller.changePassword
);

module.exports = router;
