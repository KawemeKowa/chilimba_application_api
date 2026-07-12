require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const logger = require('./config/logger');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const {
  authRouter, groupsRouter, contribRouter,
  withdrawalsRouter, committeeRouter, miscRouter,
  paymentsRouter, webhooksRouter,
} = require('./routes/user.routes');
const { adminRouter, superAdminRouter } = require('./routes/admin.routes');

const app = express();

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────────────────────
// Docs pages load scripts/styles from unpkg CDN — relax CSP for that path only
app.use((req, res, next) => {
  if (req.path.startsWith('/api-docs') || req.path === '/swagger.yaml') {
    return helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc:  ["'self'"],
          scriptSrc:   ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
          styleSrc:    ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
          connectSrc:  ["'self'", 'https://unpkg.com'],
          imgSrc:      ["'self'", 'data:', 'https:'],
        },
      },
    })(req, res, next);
  }
  helmet()(req, res, next);
});
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(o => o.trim())
  : ['*'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(compression());
app.set('trust proxy', 1);

// ─── LOGGING ──────────────────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) }
}));

// ─── BODY PARSING ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  message: { success: false, message: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  message: { success: false, message: 'Too many auth attempts. Please try again after 15 minutes.' },
});

app.use('/api', globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ─── SWAGGER DOCS (public) ────────────────────────────────────────────────────
// Serve raw spec — referenced by the UI below
app.get('/swagger.yaml', (req, res) => {
  res.setHeader('Content-Type', 'application/yaml');
  res.sendFile(path.join(__dirname, '..', 'swagger.yaml'));
});

// CDN-based Swagger UI — no local static files, works on Vercel / any serverless host
const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Chilimba API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"/>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = () => {
      SwaggerUIBundle({
        url: '/swagger.yaml',
        dom_id: '#swagger-ui',
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
        persistAuthorization: true,
      });
    };
  </script>
</body>
</html>`;

app.get('/api-docs', (req, res) => res.send(SWAGGER_HTML));
app.get('/api-docs/', (req, res) => res.send(SWAGGER_HTML));

// ─── HEALTH CHECK (public) ────────────────────────────────────────────────────
app.get(['/health', '/api/health'], (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── USER API ROUTES ──────────────────────────────────────────────────────────
app.use('/api/auth',          authRouter);
app.use('/api/groups',        groupsRouter);
app.use('/api/contributions', contribRouter);
app.use('/api/withdrawals',   withdrawalsRouter);
app.use('/api/committees',    committeeRouter);
app.use('/api',               miscRouter);  

// ─── ADMIN API ROUTES ─────────────────────────────────────────────────────────
app.use('/api/payments',      paymentsRouter);
app.use('/api/webhooks',      webhooksRouter);

// ─── ADMIN API ROUTES ─────────────────────────────────────────────────────────
app.use('/api/admin',         adminRouter);

// ─── SUPER ADMIN API ROUTES ───────────────────────────────────────────────────
app.use('/api/superadmin',    superAdminRouter);

// ─── 404 / ERROR ─────────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`🚀 Chilimba API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = app;
