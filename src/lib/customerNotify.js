/**
 * One place that sends a customer-facing message: picks the customer's language,
 * renders the template, and chooses the channels.
 *
 *   email     when the customer has an email address
 *   phone     WhatsApp when the customer opted in and an approved template exists
 *             for this message and language; otherwise SMS
 *
 * `recipient` is a Customer, or any { email, phone, language, whatsappOptInAt,
 * whatsappOptOutAt } (a waitlist entry has no language or consent: Dutch/SMS).
 */
const notificationClient = require('./notificationClient');
const logger = require('../config/logger');
const messages = require('./messages');
const whatsapp = require('./whatsapp');
const { languageFor } = require('./i18n');

async function notifyCustomer(recipient, key, vars = {}, { email = true, phone = true, html = false } = {}) {
  const language = languageFor(recipient);
  const msg = messages.render(key, language, vars);
  const sent = { email: false, sms: false, whatsapp: false, language };

  if (email && recipient.email) {
    try {
      await notificationClient.sendEmail({ to: recipient.email, subject: msg.subject, text: msg.text, ...(html ? { html: `<p>${msg.text}</p>` } : {}) });
      sent.email = true;
    } catch (e) {
      logger.error(`failed to email ${key}`, e);
    }
  }

  if (phone && recipient.phone) {
    const sid = !messages.NO_WHATSAPP.has(key) && whatsapp.canWhatsapp(recipient) ? whatsapp.contentSid(key, language) : null;
    try {
      if (sid) {
        await notificationClient.sendWhatsapp({ to: recipient.phone, contentSid: sid, variables: messages.whatsappVariables(key, vars) });
        sent.whatsapp = true;
      } else {
        await notificationClient.sendSms({ to: recipient.phone, body: msg.text });
        sent.sms = true;
      }
    } catch (e) {
      logger.error(`failed to send ${key} to phone`, e);
      // A WhatsApp failure (not delivered to the API) falls back to SMS once.
      if (sid) {
        try {
          await notificationClient.sendSms({ to: recipient.phone, body: msg.text });
          sent.sms = true;
        } catch (e2) {
          logger.error(`sms fallback failed for ${key}`, e2);
        }
      }
    }
  }
  return sent;
}

module.exports = { notifyCustomer };
