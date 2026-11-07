/**
 * WhatsApp through Twilio. A business may only START a conversation with an
 * approved template, so every message here is sent from a Twilio Content
 * template (its HX... SID) with positional variables. Templates are looked up
 * per message key and language in the environment:
 *
 *   TWILIO_WHATSAPP_FROM                      sender, e.g. +31612345678 (a WhatsApp-enabled Twilio number)
 *   TWILIO_WA_CONTENT_<KEY>_<LANG>            Content SID, e.g. TWILIO_WA_CONTENT_BOOKINGCONFIRMED_NL=HXabc...
 *
 * A message with no template configured is simply not sent on WhatsApp (the
 * caller falls back to SMS). Consent: only customers with an opt-in on record
 * and no later opt-out receive WhatsApp (see canWhatsapp).
 */

function enabled() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);
}

const asWhatsappAddress = (n) => `whatsapp:${String(n || '').replace(/^whatsapp:/, '')}`;

function contentSid(key, language) {
  return process.env[`TWILIO_WA_CONTENT_${String(key).toUpperCase()}_${String(language).toUpperCase()}`] || null;
}

/** Consent check on a customer-like object. */
function canWhatsapp(customer) {
  if (!customer || !customer.phone || !customer.whatsappOptInAt) return false;
  const optIn = new Date(customer.whatsappOptInAt).getTime();
  const optOut = customer.whatsappOptOutAt ? new Date(customer.whatsappOptOutAt).getTime() : 0;
  return optIn > optOut;
}

module.exports = { enabled, asWhatsappAddress, contentSid, canWhatsapp };
