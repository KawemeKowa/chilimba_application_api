const https   = require('https');
const http    = require('http');
const crypto  = require('crypto');
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

/**
 * Every Lipila example referenceId is a short hex string with no hyphens
 * (e.g. "f95a8f405ed1", "a9a2") — unlike crypto.randomUUID(), which includes
 * hyphens and is longer. Use this everywhere a referenceId is generated to
 * stay inside whatever length/character constraint their API enforces.
 */
function generateReferenceId() {
  return crypto.randomBytes(16).toString('hex'); // 32 hex chars, no hyphens
}

/**
 * Lipila rejects anything that isn't 260XXXXXXXXX ("Invalid phone number
 * format"), but users type 0977123456, +260 97 712 3456, and so on. Normalize
 * at this boundary so every caller — deposits, payouts using numbers already
 * saved in the DB — sends the one shape Lipila accepts.
 *
 * Zambian subscriber numbers are 9 digits starting with 9 (MTN 96, Airtel 97,
 * Zamtel 95) or 7 (MTN 76, Airtel 77, Zamtel 75). Returns null when the input
 * can't be read as one.
 */
function normalizeZmPhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;

  let subscriber;
  if (digits.startsWith('260')) subscriber = digits.slice(3);
  else if (digits.startsWith('0')) subscriber = digits.slice(1);
  else subscriber = digits;

  if (!/^[79]\d{8}$/.test(subscriber)) return null;
  return `260${subscriber}`;
}

/** Normalize or throw a 400 naming the number that failed. */
function requireZmPhone(input) {
  const normalized = normalizeZmPhone(input);
  if (!normalized) {
    const err = new Error(
      `"${input}" is not a valid Zambian mobile number. Use a format like 0977123456 or 260977123456.`
    );
    err.status = 400;
    err.statusCode = 400;
    throw err;
  }
  return normalized;
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
            // ASP.NET-style validation errors: { title: "One or more errors occurred!", errors: { Field: ["msg"] } }
            const fieldErrors = parsed.errors
              ? Object.entries(parsed.errors).map(([field, msgs]) => `${field}: ${[].concat(msgs).join(', ')}`).join(' | ')
              : null;
            const msg = fieldErrors || parsed.message || parsed.detail || parsed.title || `Lipila error ${res.statusCode}`;
            logger.error(`[lipila] ${method} ${path} → ${res.statusCode}: ${JSON.stringify(parsed)}`);
            const err = new Error(msg);
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
    accountNumber: requireZmPhone(phone),
    narration,
    currency,
    email,
    referenceData: narration,
  });
}

/**
 * Card collection (Visa / Mastercard / Amex) via Lipila's hosted checkout.
 * Docs: https://docs.lipila.dev/docs/collections/collections.html
 * Body is nested: { customerInfo, collectionRequest } — every field in both
 * objects is required by Lipila, so this fills in safe non-empty defaults
 * for anything the caller doesn't supply (rather than sending an empty
 * string, which risks the same kind of validation rejection we saw before).
 * Response carries the redirect URL as `cardRedirectionUrl` — the user
 * completes payment (incl. 3-D Secure) there; final status arrives via
 * webhook, or can be polled with checkCollectionStatus().
 */
async function initiateCardCollection({
  referenceId, amount, narration, currency = 'ZMW',
  firstName, lastName, email = '', phone = '',
  city = 'Lusaka', country = 'ZM', address = 'N/A', zip = '00000',
}) {
  // Redirect the popup to a minimal standalone return page (not /wallet, which
  // would load the whole app inside the little popup window) that self-closes.
  const frontend = FRONTEND_URL || 'https://chilimba-application-client.vercel.app';
  const fallbackBackUrl = `${frontend}/payment-return`;
  const res = await request('POST', '/collections/card', {
    customerInfo: {
      firstName: firstName || 'Chilimba',
      lastName:  lastName  || 'User',
      phoneNumber: phone || '260000000000',
      city, country, address, zip,
      email: email || 'no-reply@chilimba.app',
    },
    collectionRequest: {
      referenceId,
      amount,
      narration,
      accountNumber: phone || email || 'unknown', // identifier for the payer, per Lipila's own example
      currency,
      backUrl: fallbackBackUrl,
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
    accountNumber: requireZmPhone(phone),
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
 * Check the current status of a collection (mobile money or card) directly
 * with Lipila — same referenceId used to create the collection.
 * Docs: https://docs.lipila.dev/docs/collections/ (Collections Status)
 */
async function checkCollectionStatus(referenceId) {
  return request('GET', `/collections/check-status?referenceId=${encodeURIComponent(referenceId)}`, null);
}

/**
 * Fetch current platform Lipila wallet balance.
 */
async function getBalance() {
  return request('GET', '/merchants/balance', null);
}

module.exports = {
  generateReferenceId,
  normalizeZmPhone,
  requireZmPhone,
  initiateCollection,
  initiateCardCollection,
  initiateDisbursement,
  initiateBankDisbursement,
  checkDisbursementStatus,
  checkCollectionStatus,
  getBalance,
};
