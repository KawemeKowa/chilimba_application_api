const https  = require('https');
const http   = require('http');
const { URL } = require('url');
const logger  = require('../config/logger');

const BASE_URL  = process.env.LIPILA_API_URL  || 'https://api.lipila.dev/api/v1';
const CALLBACK  = process.env.LIPILA_CALLBACK_URL || '';

function getApiKey() {
  const key = process.env.LIPILA_API_KEY;
  if (!key) throw new Error('LIPILA_API_KEY is not set — add it to your Railway environment variables');
  return key;
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    let apiKey;
    try { apiKey = getApiKey(); } catch (e) { return reject(e); }

    const url  = new URL(`${BASE_URL}${path}`);
    const data = body ? JSON.stringify(body) : null;
    const lib  = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'accept':       'application/json',
        'x-api-key':    apiKey,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(CALLBACK  ? { 'callbackUrl': CALLBACK } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        logger.debug(`[lipila] ${method} ${path} → ${res.statusCode} body=${raw.slice(0, 300)}`);

        // Empty body — derive error from HTTP status
        if (!raw.trim()) {
          const statusMessages = {
            401: 'Lipila: Unauthorized — check your LIPILA_API_KEY',
            403: 'Lipila: Forbidden — API key may not have permission',
            404: 'Lipila: Endpoint not found — check LIPILA_API_URL',
          };
          const msg = statusMessages[res.statusCode] || `Lipila returned HTTP ${res.statusCode} with empty body`;
          const err = new Error(msg);
          err.statusCode = res.statusCode;
          return reject(err);
        }

        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode >= 400) {
            const err = new Error(parsed.message || parsed.detail || `Lipila error ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.lipila = parsed;
            return reject(err);
          }
          resolve(parsed);
        } catch {
          const err = new Error(`Lipila non-JSON response (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Initiate a mobile money collection (charge a user's MoMo number).
 * Returns Lipila's initial response — final status comes via webhook.
 */
async function initiateCollection({ referenceId, amount, phone, narration, currency = 'ZMW', email = '' }) {
  return request('POST', '/collections/mobile-money', {
    referenceId,
    amount,
    accountNumber: phone,
    narration,
    currency,
    email,
    referenceData: narration,
  });
}

/**
 * Initiate a mobile money disbursement (send money to a recipient's MoMo number).
 */
async function initiateDisbursement({ referenceId, amount, phone, narration, currency = 'ZMW' }) {
  return request('POST', '/disbursements/mobile-money', {
    referenceId,
    amount,
    accountNumber: phone,
    narration,
    currency,
    referenceData: narration,
  });
}

/**
 * Fetch current platform Lipila wallet balance.
 */
async function getBalance() {
  return request('GET', '/merchants/balance', null);
}

module.exports = { initiateCollection, initiateDisbursement, getBalance };
