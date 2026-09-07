// ─── FILE SERVING ─────────────────────────────────────────────────────────────
// Serves uploads stored on the Railway volume. Everything here is behind
// authentication — unlike Supabase's getPublicUrl(), which put government ID
// images behind a URL anyone could open.
const express = require('express');
const { authenticate } = require('../middleware/auth');
const storage = require('../services/storage.service');
const logger = require('../config/logger');

const filesRouter = express.Router();

/**
 * Browsers don't send Authorization headers on <img src="...">, so the client
 * passes the same access token as ?token=. Promote it to the header and let
 * the normal authenticate middleware do the real work.
 *
 * Note: tokens in query strings can leak via referrer headers and access logs.
 * These are the app's short-lived access tokens (not refresh tokens), which
 * keeps the exposure small, and the alternative — public unguessable URLs —
 * is what we're moving away from.
 */
const tokenFromQuery = (req, res, next) => {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
};

/**
 * Who may read what:
 *   kyc/<userId>/*  — that user, or an admin (ID documents are sensitive)
 *   everything else — any signed-in user (avatars, group covers)
 */
function canRead(user, storagePath) {
  const isAdmin = user.role === 'admin' || user.role === 'super_admin';
  const kyc = storagePath.match(/^kyc\/([^/]+)\//);
  if (kyc) return isAdmin || kyc[1] === user.id;
  return true;
}

filesRouter.get(/^\/(.+)$/, tokenFromQuery, authenticate, async (req, res, next) => {
  try {
    const storagePath = req.params[0];

    if (!canRead(req.user, storagePath)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this file.' });
    }

    const file = await storage.readFile(storagePath);
    if (!file) {
      return res.status(404).json({ success: false, message: 'File not found.' });
    }

    res.setHeader('Content-Type', file.contentType);
    // Private: these are per-user documents, so no shared/CDN caching.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Never let an upload execute in the browser's origin
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    res.send(file.buffer);
  } catch (err) {
    logger.error(`[files] serve failed: ${err.message}`);
    next(err);
  }
});

module.exports = { filesRouter };
