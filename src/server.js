require('dotenv').config();
const http = require('http');
const app = require('./app');
const { initSocket } = require('./config/socket');
const logger = require('./config/logger');

// The pricing page ("never a percentage of what your customers pay you")
// and the Terms of Service ("Lady Greener does not charge a commission on
// jobs booked through a business's site") both promise this is 0. That
// promise is only as good as this env var — nothing else in the code
// re-checks it — so refuse to start rather than let a stray config change
// silently break it in production. See .env.example for the full context.
const platformFeeBps = parseInt(process.env.PLATFORM_APPLICATION_FEE_BPS || '0', 10);
if (Number.isFinite(platformFeeBps) && platformFeeBps > 0) {
  logger.error(
    `PLATFORM_APPLICATION_FEE_BPS is set to ${platformFeeBps} (non-zero). This contradicts the ` +
    `no-commission promise on the pricing page and in the Terms of Service — refusing to start. ` +
    `Update the marketing copy first if the business model has actually changed, then raise this.`
  );
  process.exit(1);
}

const PORT = process.env.PORT || 8000;

// Stripe is the only path money moves through — job payments, deposits,
// subscription billing, and payouts. In production this must be configured
// correctly or fail LOUD at boot, not fail quietly at the worst possible
// moment:
//   - a missing/malformed STRIPE_SECRET_KEY means every checkout session,
//     Connect account, and subscription call throws a raw Stripe SDK error
//     the first time a customer tries to pay;
//   - a missing STRIPE_WEBHOOK_SECRETS/STRIPE_WEBHOOK_SECRET means Stripe's
//     payment-confirmation webhook gets correctly rejected (see
//     stripe.controller.js's 503 for this) but NOTHING then marks the
//     booking paid — and workers/depositSweeper.js will go on to auto-cancel
//     that same booking once its hold window expires, because
//     depositPaidAt never got set. A customer can be charged for a booking
//     that then gets cancelled out from under them.
// Skipped outside production so local dev and CI don't need real Stripe
// credentials just to boot the server; every existing test already mocks
// stripeClient.js directly rather than starting the server at all.
if (process.env.NODE_ENV === 'production') {
  const missing = [];
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    missing.push('STRIPE_SECRET_KEY is not set');
  } else if (!/^[rs]k_/.test(key)) {
    // Catches the classic mistake of pasting the publishable key (pk_...)
    // or a stray placeholder instead of a secret/restricted key.
    missing.push(`STRIPE_SECRET_KEY does not look like a Stripe secret key (got a value starting with "${key.slice(0, 3)}")`);
  }
  if (!process.env.STRIPE_WEBHOOK_SECRETS && !process.env.STRIPE_WEBHOOK_SECRET) {
    missing.push('neither STRIPE_WEBHOOK_SECRETS nor STRIPE_WEBHOOK_SECRET is set — payment webhooks will be rejected and no booking will ever be confirmed paid');
  }
  if (missing.length) {
    logger.error(`Refusing to start in production with an incomplete Stripe configuration: ${missing.join('; ')}. See .env.example.`);
    process.exit(1);
  }
}

const server = http.createServer(app);
initSocket(server);

server.listen(PORT, () => {
  logger.info(`Lady Greener API listening on port ${PORT}`);
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { message: err.message, stack: err.stack });
});
