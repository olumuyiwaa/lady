# Launch checklist

Everything the code needs is in; what is left is configuration in other
systems and two content items. Tick them off in order. Run
`node scripts/stagingSmoke.js` after step 5 and again on production after step 9.

## 1. Deploy and migrate

- [ ] Set the environment from `.env.example` (see sections 2-4 for the keys that matter).
- [ ] `npm ci && npx prisma generate && npm run migrate` (the latest migration adds leave,
      customer language, WhatsApp consent and waitlist language).
- [ ] `OWNER_EMAIL=... OWNER_PASSWORD=... npm run seed` on a fresh database.
- [ ] `PUBLIC_API_URL` is the public https URL of this API, no trailing slash.
- [ ] `DEFAULT_CUSTOMER_LANGUAGE=nl`.

## 2. Stripe (payments and iDEAL)

1. Use the live secret key in `STRIPE_SECRET_KEY`.
2. **iDEAL**: Stripe Dashboard → Settings → Payment methods → turn on **iDEAL** (and Bancontact,
   SEPA Direct Debit, cards if wanted). Leave `CHECKOUT_PAYMENT_METHODS` empty so Stripe shows the
   methods the account has enabled; iDEAL then appears automatically for EUR checkouts.
3. **Webhook**: Stripe Dashboard → Developers → Webhooks → add endpoint
   `https://<api host>/api/v1/webhooks/stripe` with these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.expired`, `charge.dispute.created`, `charge.dispute.closed`,
   `refund.created`, `refund.updated`.
   Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRETS`.
4. Test mode first: pay a booking with iDEAL's test bank, confirm the booking turns paid and an
   invoice appears. Then repeat once with a real €1 payment on live and refund it.

## 3. WhatsApp (Twilio)

1. Twilio Console → Messaging → WhatsApp senders: register the business number, set
   `TWILIO_WHATSAPP_FROM`.
2. Set the sender's "When a message comes in" URL to `https://<api host>/api/v1/webhooks/whatsapp`
   (POST). It handles STOP/START; requests are signature-checked with `TWILIO_AUTH_TOKEN` and
   `PUBLIC_API_URL`, so both must be right.
3. `node scripts/printWhatsappTemplates.js` prints each message in Dutch and English. Create one
   Content Template per entry (category Utility, positional variables as printed), submit for
   approval, then put each Content SID in the matching `TWILIO_WA_CONTENT_<MESSAGE>_<NL|EN>`.
   Approval takes from minutes to a couple of days. Messages without a template keep going out by SMS.
4. Tick the WhatsApp box on a test booking and check the confirmation arrives on WhatsApp, then
   reply STOP and check the next one arrives as SMS.

## 4. AI assistant

- [ ] `ANTHROPIC_API_KEY` set (empty = assistant hidden). `ASSISTANT_MODEL` defaults to `claude-haiku-5-5`.
- [ ] Fill the FAQ in the dashboard (Website → FAQ), set service descriptions, service areas and
      opening hours: the assistant answers only from these.
- [ ] Ask it five real questions in Dutch and English, including one it cannot know (it should say so).

## 5. Content the code cannot supply

- [ ] **Logo**: replace `public/images/logo/todcleaning-logo.png` in `lady_frontend` with the final
      high-resolution file (the current one is a placeholder). Check `logo.svg`, `logo-dark.svg`,
      `logo-icon.svg` and `auth-logo.svg` too, and the favicon.
- [ ] **Legal dates**: the Terms and Privacy pages carry an `effectiveDate` string
      (`"March 2021 — Updated for 2025"` in `messages/*.json`). Set it to the real effective and
      last-updated dates, have the texts checked against how Tod Cleaning Services actually works
      (KvK/BTW numbers, cancellation fee, data retention), and update both NL and EN.

## 6. Staging test of the whole flow

Run `API_BASE_URL=https://<staging api>/api/v1 node scripts/stagingSmoke.js` (see the header of the
script for the optional staff and booking checks), then walk this by hand once:

1. Site in Dutch and English; postcode checker with an Amsterdam and a far-away postcode.
2. "Build my cleaning": quote, add-on, weekly discount, coupon; book and pay with iDEAL (test).
3. Customer gets the confirmation in the chosen language (email, and WhatsApp if opted in).
4. Dashboard: booking appears; assign a cleaner (suggestions list the best match).
5. Cleaner records leave (API `POST /cleaners/me/leave`, or a manager records it under Leave);
   approve; the cleaner no longer appears in suggestions or slots for those days, and assigning
   them is refused.
6. Cleaner flow through the cleaner app/API: on my way, clock in (geofence), checklist, before/after
   photos, clock out.
7. Customer portal: sign in by SMS/email code, see the timeline and checklist, chat, review, invoice,
   change language/WhatsApp preference.
8. B2B: company account with two locations; after a few completed visits download the monthly
   statement and the **quality report (PDF)**.
9. Complaint raised from the portal appears in Support tickets.
10. Production: repeat 1-3 with real data, then switch Stripe to live and do the €1 payment test.

## Known limits (not blockers)

- Slot availability is cached for a short time; newly approved leave can take a few minutes to
  disappear from the public slot list. Assigning a cleaner on leave is refused immediately.
- Route estimates are straight-line distances, not road routing.
- The cleaner mobile app is a separate project; the API it needs (including leave) is in place.
