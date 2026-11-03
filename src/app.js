const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const routes = require('./routes');
const stripeWebhookController = require('./modules/webhooks/stripe.controller');
const errorHandler = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const app = express();

// Behind a reverse proxy or load balancer (nginx, DigitalOcean App Platform,
// ...) req.ip is the proxy's address unless Express is told how many proxy
// hops to trust. Without this every visitor shares one rate-limit bucket, so
// the 20-per-15-minutes auth limiter locks out the whole platform after 20
// sign-ins. TRUST_PROXY = number of hops ("1" for a single proxy), or "false"
// to disable. Defaults to 1 in production.
const trustProxy = process.env.TRUST_PROXY !== undefined
    ? (process.env.TRUST_PROXY === 'false' ? false : Number(process.env.TRUST_PROXY))
    : (process.env.NODE_ENV === 'production' ? 1 : false);
app.set('trust proxy', trustProxy);

// ---------- Swagger setup ----------
const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Lady Greener API',
            version: '0.1.0',
            description: 'Lady Greener operations backend',
        },
        servers: [
            { url: 'http://localhost:8000/api/v1', description: 'Local' },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
        security: [{ bearerAuth: [] }],
    },
    // Absolute paths so it works no matter where you start the process
    apis: [
        path.join(__dirname, 'modules/**/*.routes.js'),
        path.join(__dirname, 'routes/*.js'),
    ],
};

const specs = swaggerJsdoc(options);

// Mount docs BEFORE helmet so CSP does not break the UI. The interactive docs
// are a map of every endpoint, so they are off in production unless
// ENABLE_API_DOCS=true.
if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true') {
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs, {
        explorer: true,
        customSiteTitle: 'Lady Greener API Docs',
    }));
}

// ---------- Normal middleware ----------
app.use(helmet({
    contentSecurityPolicy: false, // simplest fix while developing docs
    // or keep CSP and only disable it for /api-docs if you prefer
}));

// CORS — allow only the configured frontend origin (and the booking widget
// embed domain if set). The Stripe webhook endpoint is raw bytes and does not
// go through this middleware. Tokens travel as Authorization headers, not
// cookies, so credentials:true / SameSite restrictions are not relevant here,
// but there is still no reason to let arbitrary origins read API responses.
const allowedOrigins = (() => {
    const origins = new Set();
    if (process.env.FRONTEND_URL) {
        // Support a comma-separated list for staging/preview environments.
        process.env.FRONTEND_URL.split(',').map(u => u.trim()).filter(Boolean).forEach(u => origins.add(u));
    }
    if (process.env.WIDGET_BASE_DOMAIN) {
        // The embeddable booking widget may be loaded from the tenant's own
        // domain. We can't enumerate every subdomain at startup, so accept
        // any subdomain of WIDGET_BASE_DOMAIN (the embed.js does a postMessage
        // handshake as an extra layer of protection).
        origins.add(`*.${process.env.WIDGET_BASE_DOMAIN}`);
    }
    // Always allow localhost in development so the dev server works without
    // having to set FRONTEND_URL.
    if (process.env.NODE_ENV !== 'production') {
        origins.add('http://localhost:3000');
        origins.add('http://localhost:3001');
    }
    return [...origins];
})();

app.use(
    cors({
        origin(origin, callback) {
            // Non-browser requests (curl, server-to-server, Stripe webhooks
            // handled before this middleware) have no Origin header.
            if (!origin) return callback(null, true);
            const allowed = allowedOrigins.some(pattern => {
                if (pattern.startsWith('*.')) {
                    const base = pattern.slice(2);
                    return origin.endsWith(`.${base}`) || origin === `https://${base}` || origin === `http://${base}`;
                }
                return origin === pattern;
            });
            if (allowed) return callback(null, true);
            callback(new Error(`CORS: origin "${origin}" is not allowed`));
        },
        credentials: false,
    })
);

// Stripe webhook must stay before express.json()
app.post(
    '/api/v1/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    (req, res, next) => {
        req.rawBody = req.body;
        return stripeWebhookController.handle(req, res, next);
    }
);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(apiLimiter);

app.get('/health', (req, res) =>
    res.json({ status: 'ok', service: 'ladygreener-api' })
);

app.use('/api/v1', routes);

app.use((req, res) =>
    res.status(404).json({ success: false, message: 'Route not found' })
);
app.use(errorHandler);

module.exports = app;