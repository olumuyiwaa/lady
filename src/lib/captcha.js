const logger = require('../config/logger');

/**
 * Cloudflare Turnstile verification for the public, unauthenticated write
 * endpoints. Without it anyone can script POST /widget/.../bookings and make
 * Tod Cleaning Services send SMS and email confirmations to arbitrary phone numbers and
 * addresses (SMS pumping / harassment) and fill a business's calendar.
 *
 * Set TURNSTILE_SECRET_KEY to enable. When unset the check is skipped (local
 * development), with a one-time warning in production.
 */
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
let warned = false;

async function verifyCaptcha(token, remoteIp, { fetchImpl = globalThis.fetch } = {}) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === 'production' && !warned) {
      warned = true;
      logger.warn('TURNSTILE_SECRET_KEY is not set: public booking endpoints are not protected against bots');
    }
    return true;
  }
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  if (typeof fetchImpl !== 'function') {
    logger.error('captcha verification unavailable: no fetch implementation');
    return false;
  }
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetchImpl(VERIFY_URL, { method: 'POST', body });
    const data = await res.json();
    return data && data.success === true;
  } catch (err) {
    // Fail closed: if we cannot verify, we do not let the request through.
    logger.error('captcha verification failed', { error: err.message });
    return false;
  }
}

function requireCaptcha(deps = {}) {
  return async (req, res, next) => {
    const token = (req.body && (req.body.captchaToken || req.body['cf-turnstile-response'])) || req.headers['x-captcha-token'];
    if (await verifyCaptcha(token, req.ip, deps)) return next();
    return res.status(400).json({
      success: false,
      message: 'Please complete the verification challenge and try again.',
      errors: { code: 'CAPTCHA_FAILED' },
    });
  };
}

function _resetWarning() {
  warned = false;
}

module.exports = { verifyCaptcha, requireCaptcha, _resetWarning };
