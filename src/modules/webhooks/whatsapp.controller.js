/**
 * Twilio inbound webhook for the WhatsApp sender (set it as the sender's
 * "When a message comes in" URL: POST /api/v1/webhooks/whatsapp).
 *
 *   STOP / STOPPEN / AFMELDEN / UNSUBSCRIBE   -> opt out
 *   START / AAN / AANMELDEN / SUBSCRIBE        -> opt in again (a customer who
 *                                                 messages us first has chosen to)
 *
 * Requests are checked with Twilio's signature (X-Twilio-Signature) against
 * PUBLIC_API_URL + the request path. Replies are TwiML so Twilio answers in the
 * customer's language. Customers are matched by phone number across businesses
 * (one business here, but the schema allows more).
 */
const twilio = require('twilio');
const prisma = require('../../config/database');
const logger = require('../../config/logger');
const { normalizePhone } = require('../../lib/phone');
const { languageFor } = require('../../lib/i18n');

const STOP = new Set(['stop', 'stoppen', 'afmelden', 'unsubscribe', 'cancel', 'end']);
const START = new Set(['start', 'aan', 'aanmelden', 'subscribe', 'yes', 'ja']);

const REPLY = {
  stop: { nl: 'Je krijgt geen WhatsApp-berichten meer van ons. Stuur START om weer berichten te ontvangen.', en: 'You will no longer receive WhatsApp messages from us. Send START to receive them again.' },
  start: { nl: 'Je ontvangt weer WhatsApp-berichten van ons. Stuur STOP om je af te melden.', en: 'You will receive WhatsApp messages from us again. Send STOP to opt out.' },
};

function classify(body) {
  const word = String(body || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (STOP.has(word)) return 'stop';
  if (START.has(word)) return 'start';
  return null;
}

function validSignature(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  const base = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
  const url = `${base}${req.originalUrl.split('?')[0]}`;
  return twilio.validateRequest(token, req.get('X-Twilio-Signature') || '', url, req.body || {});
}

const twiml = (text) => `<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${text.replace(/[<>&]/g, '')}</Message>` : ''}</Response>`;

async function handle(req, res, next) {
  try {
    if (!validSignature(req)) return res.status(403).type('text/plain').send('Invalid signature');
    const from = normalizePhone(String(req.body.From || '').replace(/^whatsapp:/, ''));
    const action = classify(req.body.Body);
    res.type('text/xml');
    if (!action || !from) return res.send(twiml(''));

    const customers = await prisma.customer.findMany({ where: { phone: from }, select: { id: true, language: true } });
    if (customers.length === 0) return res.send(twiml(''));
    const now = new Date();
    await prisma.customer.updateMany({
      where: { id: { in: customers.map((c) => c.id) } },
      data: action === 'stop' ? { whatsappOptOutAt: now } : { whatsappOptInAt: now },
    });
    logger.info('whatsapp consent changed', { action, customers: customers.length });
    return res.send(twiml(REPLY[action][languageFor(customers[0])]));
  } catch (err) {
    next(err);
  }
}

module.exports = { handle, classify };
