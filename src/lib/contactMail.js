const logger = require('../config/logger');

// Loaded on first send, not at import: notificationClient connects to the queue
// (Redis) when required, and the pure helpers below are used by code that must
// not open that connection just to validate an address.
const mailClient = () => require('./notificationClient');

/** One line, no control characters, bounded. Safe for a subject line or a greeting. */
function oneLine(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Pragmatic address check (the mail provider is the real validator). */
function isEmailAddress(value) {
  const v = String(value ?? '');
  return v.length <= 254 && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/.test(v);
}

/** Free-text phone as shown to humans: digits, spaces and + ( ) . - only. */
function isPhoneText(value) {
  return /^[+\d\s().-]{5,40}$/.test(String(value ?? ''));
}

/** Short, human-quotable reference derived from a record id, e.g. "T-3F9K2QXA". */
function referenceFromId(id, prefix = 'T') {
  return `${prefix}-${String(id).slice(-8).toUpperCase()}`;
}

/**
 * Sends one email and reports whether it was actually handed to a provider.
 * Never throws - a mail problem must not fail the request that triggered it.
 * Returns false when no provider is configured (the client would only log).
 */
async function sendTracked({ to, subject, text, replyTo }) {
  if (!to) return false;
  const notificationClient = mailClient();
  if (!notificationClient.isEmailConfigured()) {
    logger.warn('email not sent: no mail provider configured', { to, subject });
    return false;
  }
  try {
    await notificationClient.sendEmail({ to, subject: oneLine(subject, 200), text, replyTo: replyTo || undefined });
    return true;
  } catch (err) {
    logger.error('email send failed', { to, subject, error: err.message });
    return false;
  }
}

module.exports = { oneLine, referenceFromId, sendTracked, isEmailAddress, isPhoneText };
