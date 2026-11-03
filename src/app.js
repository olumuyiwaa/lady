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

app.use(
    cors({
        origin: true,
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