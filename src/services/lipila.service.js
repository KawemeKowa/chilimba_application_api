const https  = require('https');
const http   = require('http');
const { URL } = require('url');
const logger  = require('../config/logger');

// Docs: https://docs.lipila.dev/docs/gettingstarted/methods.html
// Sandbox base: https://api.lipila.dev/api/v1  |  Live base: https://blz.lipila.io/api/v1
const BASE_URL  = process.env.LIPILA_API_URL  || 'https://api.lipila.dev/api/v1';
const CALLBACK  = process.env.LIPILA_CALLBACK_URL || '';
const FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim();

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
 * Mobile money collection (charge a user's MoMo number).
 * Docs: https://docs.lipila.dev/docs/collections/momocollections.html
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
 * Card collection (Visa / Mastercard / Amex) via Lipila's hosted checkout.
 * Docs: https://docs.lipila.dev/docs/collections/collections.html
 * Body is nested: { customerInfo, collectionRequest }. Response carries the
 * redirect URL as `cardRedirectionUrl` — the user completes payment (incl.
 * 3-D Secure) there; final status arrives via webhook like every other method.
 */
async function initiateCardCollection({
  referenceId, amount, narration, currency = 'ZMW',
  firstName, lastName, email = '', phone = '',
  city = 'Lusaka', country = 'ZM', address = '', zip = '',
}) {
  const res = await request('POST', '/collections/card', {
    customerInfo: {
      firstName: firstName || 'Chilimba',
      lastName:  lastName  || 'User',
      phoneNumber: phone,
      city, country, address, zip,
      email,
    },
    collectionRequest: {
      referenceId,
      amount,
      narration,
      accountNumber: email || phone, // Lipila uses this as the payer's identifier for card txns
      currency,
      backUrl: FRONTEND_URL ? `${FRONTEND_URL}/wallet` : undefined,
      referenceData: narration,
    },
  });
  res.paymentUrl = res.cardRedirectionUrl || null;
  return res;
}

/**
 * Mobile money disbursement (send money to a recipient's MoMo number).
 * Docs: https://docs.lipila.dev/docs/disbursements/momodisbursements.html
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
 * Bank disbursement (send money to a recipient's bank account).
 * Docs: https://docs.lipila.dev/docs/disbursements/bank-disbursement.html
 */
async function initiateBankDisbursement({
  referenceId, amount, currency = 'ZMW', narration,
  accountNumber, swiftCode, firstName, lastName, accountHolderName,
  phoneNumber, email = '', referenceData,
}) {
  return request('POST', '/disbursements/bank', {
    referenceId,
    amount,
    currency,
    narration,
    accountNumber,
    swiftCode,
    firstName,
    lastName,
    accountHolderName,
    phoneNumber,
    email,
    referenceData: referenceData || narration,
  });
}

/**
 * Check the current status of a disbursement directly with Lipila —
 * useful when a webhook is delayed or missed.
 * Docs: https://docs.lipila.dev/docs/disbursements/disbursements-status.html
 */
async function checkDisbursementStatus(referenceId) {
  return request('GET', `/disbursements/check-status?referenceId=${encodeURIComponent(referenceId)}`, null);
}

/**
 * Fetch current platform Lipila wallet balance.
 */
async function getBalance() {
  return request('GET', '/merchants/balance', null);
}

module.exports = {
  initiateCollection,
  initiateCardCollection,
  initiateDisbursement,
  initiateBankDisbursement,
  checkDisbursementStatus,
  getBalance,
};
