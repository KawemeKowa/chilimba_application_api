const { query } = require('../config/db');
const lipila = require('./lipila.service');
const logger = require('../config/logger');

/**
 * Reconciliation sweep.
 *
 * A collection can succeed at the provider and never reach us: the webhook is
 * missed because LIPILA_CALLBACK_URL isn't set, the callback fails, or the
 * process restarts mid-deploy. The money has left the customer either way, so
 * waiting for a push we may never get is not acceptable — this pulls instead.
 *
 * Runs on an interval and can be triggered by an admin. Applying the result
 * goes through the same processLipilaEvent path as the webhook, which claims
 * the row atomically, so a sweep racing a late webhook cannot double-credit.
 */

// Give the provider a moment to send the webhook itself before we chase it.
const MIN_AGE_MINUTES = Number(process.env.RECONCILE_MIN_AGE_MINUTES || 5);
// Stop chasing forever; after this many checks a human should look.
const MAX_ATTEMPTS = Number(process.env.RECONCILE_MAX_ATTEMPTS || 12);
// Cap per run so a large backlog can't hammer the provider or block the loop.
const BATCH_SIZE = Number(process.env.RECONCILE_BATCH_SIZE || 25);

/**
 * @param {object} opts
 * @param {string} opts.source        'sweep' | 'admin'
 * @param {string=} opts.referenceId  check just this one
 * @param {string=} opts.actorId      admin who triggered it
 */
async function reconcilePending({ source = 'sweep', referenceId = null, actorId = null } = {}) {
  // Required late: payments.controller requires this module's caller chain.
  const { processLipilaEvent } = require('../controllers/user/payments.controller');

  const pending = referenceId
    ? await query(
        `SELECT reference_id, type, check_attempts FROM lipila_transactions
         WHERE reference_id = $1 AND status = 'pending'`,
        [referenceId]
      )
    : await query(
        `SELECT reference_id, type, check_attempts FROM lipila_transactions
         WHERE status = 'pending'
           AND created_at < NOW() - ($1 || ' minutes')::interval
           AND check_attempts < $2
         ORDER BY created_at ASC
         LIMIT $3`,
        [String(MIN_AGE_MINUTES), MAX_ATTEMPTS, BATCH_SIZE]
      );

  if (!pending.rows.length) return { checked: 0, resolved: 0, stillPending: 0, errors: 0 };

  let resolved = 0, stillPending = 0, errors = 0;

  for (const row of pending.rows) {
    try {
      const statusRes = row.type === 'disbursement'
        ? await lipila.checkDisbursementStatus(row.reference_id)
        : await lipila.checkCollectionStatus(row.reference_id);

      // Lipila's check-status omits referenceId in some responses — put ours
      // back so the processor can find the row.
      const result = await processLipilaEvent(
        { ...statusRes, referenceId: row.reference_id },
        { source, actorId }
      );
      if (result?.applied) resolved++; else stillPending++;
    } catch (e) {
      errors++;
      // Count the attempt even on failure, so an endlessly failing lookup
      // eventually stops being retried and surfaces for review instead.
      await query(
        `UPDATE lipila_transactions
         SET check_attempts = check_attempts + 1, last_checked_at = NOW(),
             needs_review = (check_attempts + 1 >= $2),
             updated_at = NOW()
         WHERE reference_id = $1`,
        [row.reference_id, MAX_ATTEMPTS]
      ).catch(() => {});
      logger.error(`[reconcile] ${row.reference_id} check failed: ${e.message}`);
    }
  }

  const summary = { checked: pending.rows.length, resolved, stillPending, errors };
  if (resolved || errors) {
    logger.info(`[reconcile] ${JSON.stringify(summary)}`);
  }
  return summary;
}

/** Transactions a human needs to look at. */
async function listNeedingReview({ limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT lt.id, lt.reference_id, lt.lipila_id, lt.type, lt.status,
            lt.amount::float8 AS amount, lt.currency, lt.account_number,
            lt.payment_type, lt.discrepancy, lt.needs_review,
            lt.check_attempts, lt.last_checked_at, lt.reconciled_at,
            lt.reconciliation_source, lt.created_at,
            lt.user_id, u.first_name, u.last_name, u.email,
            lt.group_id, g.name AS group_name, lt.wallet_id
     FROM lipila_transactions lt
     LEFT JOIN users  u ON u.id = lt.user_id
     LEFT JOIN groups g ON g.id = lt.group_id
     WHERE lt.needs_review = TRUE
        OR lt.discrepancy IS NOT NULL
        OR (lt.status = 'pending' AND lt.created_at < NOW() - ($1 || ' minutes')::interval)
     ORDER BY lt.created_at DESC
     LIMIT $2`,
    [String(MIN_AGE_MINUTES), limit]
  );
  return rows;
}

let timer = null;

/** Start the periodic sweep. No-op if already running or disabled. */
function startReconciliationLoop() {
  if (timer) return;
  const minutes = Number(process.env.RECONCILE_INTERVAL_MINUTES || 10);
  if (minutes <= 0) {
    logger.info('[reconcile] sweep disabled (RECONCILE_INTERVAL_MINUTES <= 0)');
    return;
  }
  timer = setInterval(() => {
    reconcilePending({ source: 'sweep' })
      .catch(e => logger.error(`[reconcile] sweep failed: ${e.message}`));
  }, minutes * 60 * 1000);
  // Don't hold the process open on shutdown
  if (timer.unref) timer.unref();
  logger.info(`[reconcile] sweep every ${minutes}m (pending older than ${MIN_AGE_MINUTES}m, max ${MAX_ATTEMPTS} tries)`);
}

module.exports = { reconcilePending, listNeedingReview, startReconciliationLoop, MIN_AGE_MINUTES, MAX_ATTEMPTS };
