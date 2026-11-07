/**
 * Customer-facing message templates, Dutch and English.
 *
 * Each template lists its variables in order (`vars`). The same order is used
 * for the positional {{1}}, {{2}} ... placeholders of the WhatsApp templates
 * registered with Meta/Twilio, so the WhatsApp text and the SMS/email text are
 * the same sentence. `scripts/printWhatsappTemplates.js` prints them for
 * submission. Dates arrive already formatted in the customer's language.
 */
const { normalizeLanguage, defaultLanguage } = require('./i18n');

const T = {
  bookingReceived: {
    vars: ['name', 'when'],
    nl: {
      subject: 'We hebben je boeking ontvangen',
      text: ({ name, when }) => `Bedankt ${name}, we hebben je boeking voor ${when} ontvangen. Je hoort van ons zodra deze is bevestigd.`,
    },
    en: {
      subject: 'Your booking request was received',
      text: ({ name, when }) => `Thanks ${name}, we received your booking for ${when}. We'll notify you when it's confirmed.`,
    },
  },
  bookingConfirmed: {
    vars: ['name', 'when', 'link'],
    nl: {
      subject: 'Je boeking is bevestigd',
      text: ({ name, when, link }) => `Hoi ${name}, je schoonmaak op ${when} is bevestigd. Beheer je boeking: ${link}`,
    },
    en: {
      subject: 'Your booking is confirmed',
      text: ({ name, when, link }) => `Hi ${name}, your cleaning on ${when} is confirmed. Manage your booking: ${link}`,
    },
  },
  onMyWay: {
    vars: ['business'],
    nl: {
      subject: ({ business }) => `${business}: je schoonmaker is onderweg`,
      text: ({ business }) => `${business}: je schoonmaker is onderweg! Ze zijn zo bij je.`,
    },
    en: {
      subject: ({ business }) => `${business}: your cleaner is on the way`,
      text: ({ business }) => `${business}: your cleaner is on their way! They'll arrive shortly.`,
    },
  },
  reminder: {
    vars: ['name', 'when'],
    nl: {
      subject: 'Herinnering: je schoonmaak komt eraan',
      text: ({ name, when }) => `Hoi ${name}, een herinnering dat je schoonmaak gepland staat op ${when}.`,
    },
    en: {
      subject: 'Upcoming cleaning reminder',
      text: ({ name, when }) => `Hi ${name}, this is a reminder that your cleaning is scheduled for ${when}.`,
    },
  },
  reviewRequest: {
    vars: ['name', 'link'],
    nl: {
      subject: 'Hoe was je schoonmaak?',
      text: ({ name, link }) => `Hoi ${name}, bedankt dat je voor ons koos. Geef je schoonmaak een beoordeling en laat een korte review achter: ${link}`,
    },
    en: {
      subject: 'How was your cleaning?',
      text: ({ name, link }) => `Hi ${name}, thanks for choosing us. Please rate your recent cleaning and leave a short review: ${link}`,
    },
  },
  paymentLink: {
    vars: ['name', 'when', 'url'],
    nl: {
      subject: 'Betaling voor je schoonmaak',
      text: ({ name, when, url }) => `Hoi ${name}, bedankt voor je boeking op ${when}. Je kunt hier veilig online betalen: ${url}`,
    },
    en: {
      subject: 'Payment for your cleaning',
      text: ({ name, when, url }) => `Hi ${name}, thank you for your booking on ${when}. You can pay securely online here: ${url}`,
    },
  },
  accessCode: {
    vars: ['business', 'code'],
    nl: {
      subject: 'Je toegangscode',
      text: ({ business, code }) => `Je toegangscode voor ${business} is ${code}. Deze is 10 minuten geldig.`,
    },
    en: {
      subject: 'Your access code',
      text: ({ business, code }) => `Your ${business} access code is ${code}. It expires in 10 minutes.`,
    },
  },
  waitlistOpened: {
    vars: ['business', 'when'],
    nl: {
      subject: ({ business }) => `${business}: er is een plek vrijgekomen`,
      text: ({ business, when }) => `${business}: er is een plek vrijgekomen op ${when}. Boek nu voordat hij weg is!`,
    },
    en: {
      subject: ({ business }) => `${business}: a slot opened up`,
      text: ({ business, when }) => `${business}: a slot just opened up for ${when}. Book now before it's gone!`,
    },
  },
  chatMessage: {
    vars: ['business', 'who', 'preview'],
    nl: {
      subject: ({ business, who }) => `${business}: nieuw bericht van ${who}`,
      text: ({ who, preview }) => `${who} heeft je een bericht gestuurd over je boeking:\n\n"${preview}"\n\nLog in op je klantenportaal om te antwoorden.`,
    },
    en: {
      subject: ({ business, who }) => `${business}: new message from ${who}`,
      text: ({ who, preview }) => `${who} sent you a message about your booking:\n\n"${preview}"\n\nSign in to your customer portal to reply.`,
    },
  },
  referralReward: {
    vars: ['business', 'code', 'amount'],
    nl: {
      subject: ({ business }) => `${business}: je beloning voor de aanbeveling`,
      text: ({ business, code, amount }) => `${business}: bedankt voor de aanbeveling! Het eerste bezoek van je vriend is klaar. Gebruik code ${code} voor ${amount} korting op je volgende boeking.`,
    },
    en: {
      subject: ({ business }) => `${business}: your referral reward`,
      text: ({ business, code, amount }) => `${business}: thanks for the referral! Your friend's first visit is done. Use code ${code} for ${amount} off your next booking.`,
    },
  },
};

/** Keys that must never go over WhatsApp (security codes stay on SMS/email). */
const NO_WHATSAPP = new Set(['accessCode', 'chatMessage']);

function render(key, language, vars = {}) {
  const tpl = T[key];
  if (!tpl) throw new Error(`Unknown message template: ${key}`);
  const lang = normalizeLanguage(language) || defaultLanguage();
  const body = tpl[lang];
  const safe = { ...vars };
  for (const v of tpl.vars) if (safe[v] == null) safe[v] = '';
  return {
    subject: typeof body.subject === 'function' ? body.subject(safe) : body.subject,
    text: body.text(safe),
    language: lang,
  };
}

/** Variables in WhatsApp's positional form: { "1": first, "2": second, ... }. */
function whatsappVariables(key, vars = {}) {
  return Object.fromEntries(T[key].vars.map((v, i) => [String(i + 1), String(vars[v] == null ? '' : vars[v])]));
}

module.exports = { templates: T, render, whatsappVariables, NO_WHATSAPP };
