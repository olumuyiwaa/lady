# Tod Cleaning Services API

Backend for **Tod Cleaning Services**, a cleaning company in the Netherlands: online
booking, scheduling and dispatch, cleaners and their documents, payroll,
invoicing with Dutch BTW, customer portal, reviews, waitlist, inventory,
compliance and a transaction log.

It started from the multi-tenant CleanSera platform and keeps its feature set
and database schema, but runs **one business**. There is no signup, no
subscription plan, no super admin, no custom domains and no Stripe Connect.

Frontend: [lady_frontend](https://github.com/olumuyiwaa/lady_frontend)

## How the single business works

- Every table still carries `businessId`, so the schema can take more
  locations later. `npm run seed` creates the one `Business` and its owner.
- `src/middleware/scopeToBusiness.js` uses the logged-in user's business; a
  `businessId` sent by a client is ignored.
- `src/middleware/resolveSingleBusiness.js` serves the public booking widget
  and customer portal. It always resolves to the one business (`BUSINESS_ID`,
  or the oldest business row), whatever Host or `:subdomain` the request has.
- `src/lib/subscriptionAccess.js` never enforces anything.
- Registration (`POST /auth/register`) is closed. Staff are added by the owner
  from the dashboard (`/businesses/staff`).

## Payments

Customers pay Tod Cleaning Services' **own Stripe account** (`STRIPE_SECRET_KEY`).
The business row stores `stripeConnectedAccountId = 'direct'`, which makes
`lib/stripeClient.js` send no `stripeAccount` header, so existing "is Stripe
set up?" checks keep working. Prices are VAT-inclusive; see `src/lib/vat.js`.
Add one webhook endpoint at `/api/v1/webhooks/stripe` and put its signing
secret in `STRIPE_WEBHOOK_SECRETS`.

## Setup

```bash
cp .env.example .env        # fill DATABASE_URL, JWT secrets, STRIPE_*, OWNER_*
npm ci
npx prisma generate
npm run migrate             # deploy existing migrations (production / CI); run after every pull
# npm run migrate:dev       # create a new migration (local dev schema changes)
OWNER_EMAIL=owner@todcleaning.nl OWNER_PASSWORD='a-long-password' npm run seed
npm run dev
```

Workers (run alongside the API in production):

| Script | Command | What it does |
|--------|---------|--------------|
| `notification-worker` | `npm run notification-worker` | Drains the Bull queue — sends email & SMS jobs |
| `recurring-daemon` | `npm run recurring-daemon` | Cron (default every 5 min) — generates upcoming recurring visits, sweeps unpaid deposits and issues referral rewards once their hold period has passed |
| `reminder-daemon` | `npm run reminder-daemon` | Cron (default hourly) — sends booking reminder messages |
| `sweep-deposits` | `npm run sweep-deposits` | One-shot deposit sweeper (also run inside the recurring daemon) |
| `precompute-slots` | `npm run precompute-slots` | Warms the Redis slot cache for the booking widget; run once daily |

## Features beyond booking

| Area | What it does | Where |
|---|---|---|
| Dispatch scoring | Ranks cleaners per booking (proximity, rating, history with the customer, workload, customer's preferred cleaner) and explains why | `lib/matchScore.js` |
| Travel fee | Distance-based fee added to a quote | `lib/travelFee.js` |
| Live map | Where cleaners are and which jobs are running | `modules/dispatch/dispatch.live.js`, `GET /dispatch/live` |
| Day planner | Proposes which cleaner takes each unassigned job with the least extra driving; nothing changes until applied. Customer times never move | `lib/dayPlanner.js`, `modules/dispatch/dispatch.plan.js`, `GET /dispatch/plan`, `POST /dispatch/plan/apply` (needs the `autoDispatch` plan feature) |
| Complaints | Complaint tickets with SLA timers | `lib/ticketSla.js`, `modules/supportTickets/complaints.service.js` |
| B2B accounts | Company customers with several locations, payment terms and a monthly statement (CSV). The statement is not a legal invoice | `lib/b2bAccount.js`, `modules/b2b` |
| Referrals | Admin-managed settings, abuse checks, reward promised at booking and issued when the booking completes (after a configurable hold). One reward per booking | `lib/referral.js`, `modules/referrals` |
| Insights | Revenue, demand by weekday/hour, repeat rate, cancellations, per-cleaner rating and punctuality, plus plain-language findings | `lib/insights.js`, `GET /reports/insights?from=&to=` (default last 30 days, max range enforced) |

| Leave | Cleaners request time off (`POST /cleaners/me/leave`); managers approve or reject (`/leave`) or record it directly. Approved leave blocks assignment and removes the cleaner from matching, the day planner and slot capacity. Approving returns the jobs that need reassigning | `modules/leave`, `lib/leave.js` |
| Quality report | Per branch and month: rating, checklist completion, punctuality (check-in within 10 min of start), complaints. JSON and PDF in the customer's language | `lib/qualityReport.js`, `modules/b2b/quality.pdf.js`, `GET /portal/b2b/quality(.pdf)` |
| Languages | `Customer.language` (nl/en, from the site language at first booking, editable in the portal) picks the language of every customer email, SMS and WhatsApp. Default `DEFAULT_CUSTOMER_LANGUAGE` (nl) | `lib/i18n.js`, `lib/messages.js`, `lib/customerNotify.js` |
| WhatsApp | Twilio WhatsApp with approved templates, only for customers who opted in (booking checkbox or portal). STOP/START replies handled at `POST /webhooks/whatsapp`. No template configured, or a failure: SMS. Access codes never use WhatsApp | `lib/whatsapp.js`, `modules/webhooks/whatsapp.controller.js`, `scripts/printWhatsappTemplates.js` |

| AI assistant | `POST /widget/assistant` answers visitor questions from the business's own services, prices, add-ons, areas, hours, cancellation policy, referral offer and FAQ (Anthropic API, `ANTHROPIC_API_KEY`). Stateless, rate limited, cannot book or see accounts. `assistantEnabled` in the storefront payload tells the site whether to show it | `modules/assistant` |

Known limits: bookings created by admins never earn referral rewards; a B2B
company has one portal login; the day planner estimates driving from straight-line
distance when addresses lack coordinates.

## Tests

```bash
npm run test:unit
```

Unit tests mock the database layer; CI only needs `npx prisma generate`.
