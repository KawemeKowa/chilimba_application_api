require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

const logger = require('./config/logger');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const {
  authRouter, groupsRouter, contribRouter,
  withdrawalsRouter, committeeRouter, miscRouter
} = require('./routes/user.routes');
const { adminRouter, superAdminRouter } = require('./routes/admin.routes');

const app = express();

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api-docs')) {
    return helmet({ contentSecurityPolicy: false })(req, res, next);
  }
  helmet()(req, res, next);
});
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
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
const swaggerDocument = yaml.load(
  fs.readFileSync(path.join(__dirname, '..', 'swagger.yaml'), 'utf8')
);
app.get('/swagger.yaml', (req, res) => {
  res.setHeader('Content-Type', 'application/yaml');
  res.sendFile(path.join(__dirname, '..', 'swagger.yaml'));
});
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customSiteTitle: 'Chilimba API Docs',
  swaggerOptions: { persistAuthorization: true },
}));

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
app.use('/api',               miscRouter);   // wallet, notifications, messages

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
