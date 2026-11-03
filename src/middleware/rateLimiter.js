const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, please try again later' },
});

const widgetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down' },
});

// Anything that creates a booking or sends a message to an arbitrary phone or
// address from the public widget. Much stricter than the read-side limiter.
const widgetSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many booking attempts from this address, please try again later' },
});

// Public marketing-site forms (support message, demo request): same shape as the
// widget submit limiter but with wording that fits, and a separate counter so
// a visitor browsing a storefront is not locked out of the contact form.
const publicFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many messages from this address, please try again later' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const keyByIpAndEmail = (req) => `${req.ip}:${String((req.body && req.body.email) || '').toLowerCase()}`;

// Per (IP, account) so one attacker cannot lock a whole office out of login
// and one account cannot be sprayed from a single address.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: keyByIpAndEmail,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many sign-in attempts, please try again later' },
});

// Stops reset-email bombing of a victim's inbox.
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: keyByIpAndEmail,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many reset requests, please try again later' },
});

// Refresh is called automatically by every client; keep this generous, since
// mobile carriers put many users behind one address.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please slow down' },
});

// Authenticated endpoints that verify a secret (2FA setup/disable, email OTP).
const sensitiveActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.user && req.user.id) || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, please try again later' },
});

module.exports = {
  authLimiter,
  widgetLimiter,
  apiLimiter,
  loginLimiter,
  passwordResetLimiter,
  refreshLimiter,
  sensitiveActionLimiter,
  widgetSubmitLimiter,
  publicFormLimiter,
};
