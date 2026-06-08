const logger = require('../config/logger');

const errorHandler = (err, req, res, next) => {
  logger.error(JSON.stringify({
    message: err.message || String(err),
    code: err.code,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    userId: req.user?.id,
  }));

  if (err.code === '23505') {
    // Postgres unique violation
    return res.status(409).json({ success: false, message: 'Duplicate entry', detail: err.detail });
  }
  if (err.code === '23503') {
    // Foreign key violation
    return res.status(400).json({ success: false, message: 'Referenced record not found' });
  }
  if (err.code === '23514') {
    // Check constraint
    return res.status(400).json({ success: false, message: 'Constraint violation', detail: err.detail });
  }

  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : 'Internal server error';
  res.status(status).json({ success: false, message });
};

const notFound = (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` });
};

// Standard paginator helper
const paginate = (req) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(
    parseInt(req.query.limit) || parseInt(process.env.DEFAULT_PAGE_SIZE) || 20,
    parseInt(process.env.MAX_PAGE_SIZE) || 100
  );
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

const paginatedResponse = (res, data, total, { page, limit }) => {
  res.json({
    success: true,
    data,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
};

module.exports = { errorHandler, notFound, paginate, paginatedResponse };
