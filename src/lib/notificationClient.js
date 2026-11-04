const nodemailer = require('nodemailer');
const twilio = require('twilio');
const sendgrid = require('@sendgrid/mail');
const logger = require('../config/logger');
let queue;
try {
  // optional dependency, only used when NOTIFICATION_QUEUE=true
  const q = require('./queue');
  queue = q.notificationQueue;
} catch (e) {
  // ignore
}

let transporter;
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

let twClient;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// .env.example documents TWILIO_FROM_NUMBER while the code read TWILIO_FROM, so
// following the example left SMS silently disabled. Accept both.
const TWILIO_FROM = () => process.env.TWILIO_FROM || process.env.TWILIO_FROM_NUMBER;

if (process.env.SENDGRID_API_KEY) {
  sendgrid.setApiKey(process.env.SENDGRID_API_KEY);
}

// Push (Firebase Cloud Messaging) — same optional-dependency, graceful-
// fallback shape as SMTP/Twilio above: if firebase-admin isn't installed or
// FIREBASE_SERVICE_ACCOUNT_JSON isn't set, sendPush() just logs and resolves
// instead of throwing, so the cleaner app / backend keep working in dev or
// in any deployment that hasn't wired push up yet.
let fcmApp;
try {
  // Either one JSON blob, or the three separate variables (the form
  // .env.example documented but the code never read).
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY
      ? {
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }
      : null;
  if (serviceAccount) {
    const admin = require('firebase-admin');
    fcmApp = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
} catch (e) {
  logger.error('Failed to initialize firebase-admin for push notifications', e);
  fcmApp = undefined;
}

async function _sendEmailNow({ to, subject, text, html, from, replyTo }) {
  from = from || process.env.EMAIL_FROM || 'no-reply@todcleaning.nl';
  if (process.env.SENDGRID_API_KEY) {
    try {
      // await, so a SendGrid failure is caught here and falls through to SMTP
      // (returning the bare promise skipped the catch entirely).
      return await sendgrid.send({ to, from, subject, text, html, ...(replyTo ? { replyTo } : {}) });
    } catch (e) {
      logger.error('sendGrid send failed, falling back to SMTP', e);
    }
  }

  if (!transporter) {
    logger.info('sendEmail fallback (no SMTP or SendGrid):', { to, subject });
    return Promise.resolve();
  }

  return transporter.sendMail({ from, to, subject, text, html, ...(replyTo ? { replyTo } : {}) });
}

async function _sendSmsNow({ to, body }) {
  if (!twClient || !TWILIO_FROM()) {
    logger.info('sendSms fallback (no Twilio):', { to, body });
    return Promise.resolve();
  }

  return twClient.messages.create({ body, from: TWILIO_FROM(), to });
}

/**
 * tokens: string | string[] of FCM registration tokens.
 * Returns { successCount, failureCount, invalidTokens } so callers can prune
 * dead tokens from CleanerDeviceToken — a token goes invalid whenever the
 * app is uninstalled, so this list will be non-empty in steady state.
 */
async function _sendPushNow({ tokens, title, body, data }) {
  const tokenList = (Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean);
  if (!fcmApp || tokenList.length === 0) {
    logger.info('sendPush fallback (no Firebase configured or no tokens):', { title, body, tokenCount: tokenList.length });
    return { successCount: 0, failureCount: 0, invalidTokens: [] };
  }

  const admin = require('firebase-admin');
  const message = {
    tokens: tokenList,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
  };

  const res = await admin.messaging(fcmApp).sendEachForMulticast(message);
  const invalidTokens = [];
  res.responses.forEach((r, i) => {
    if (!r.success && ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(r.error?.code)) {
      invalidTokens.push(tokenList[i]);
    }
  });
  return { successCount: res.successCount, failureCount: res.failureCount, invalidTokens };
}

async function sendEmail(payload) {
  if (process.env.NOTIFICATION_QUEUE === 'true' && queue) {
    await queue.add('email', payload, { attempts: 5 });
    return { queued: true };
  }
  return _sendEmailNow(payload);
}

async function sendSms(payload) {
  if (process.env.NOTIFICATION_QUEUE === 'true' && queue) {
    await queue.add('sms', payload, { attempts: 5 });
    return { queued: true };
  }
  return _sendSmsNow(payload);
}

async function sendPush(payload) {
  if (process.env.NOTIFICATION_QUEUE === 'true' && queue) {
    await queue.add('push', payload, { attempts: 3 });
    return { queued: true };
  }
  return _sendPushNow(payload);
}

/**
 * True when a mail provider is configured. Without one, sendEmail() only logs
 * and resolves, so callers that tell a user "we emailed them" must check this
 * rather than trust a resolved promise.
 */
function isEmailConfigured() {
  return !!(process.env.SENDGRID_API_KEY || transporter);
}

module.exports = { sendEmail, sendSms, sendPush, isEmailConfigured, _sendEmailNow, _sendSmsNow, _sendPushNow };
