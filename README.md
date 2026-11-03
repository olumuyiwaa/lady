# Lady Greener API

Backend for **Lady Greener**, a cleaning company in the Netherlands: online
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

Customers pay Lady Greener's **own Stripe account** (`STRIPE_SECRET_KEY`).
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
npm run migrate
OWNER_EMAIL=owner@ladygreener.nl OWNER_PASSWORD='a-long-password' npm run seed
npm run dev
```

Workers (run alongside the API in production): `notification-worker`,
`recurring-daemon`, `reminder-daemon`, `sweep-deposits`, `precompute-slots`.

## Tests

```bash
npm run test:unit
```

Unit tests mock the database layer; CI only needs `npx prisma generate`.
