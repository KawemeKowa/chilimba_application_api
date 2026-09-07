const { query, withTransaction } = require('../../config/db');
const { reconcilePending, listNeedingReview } = require('../../services/reconciliation.service');
const { recordPaymentEvent } = require('../user/payments.controller');
const logger = require('../../config/logger');

// ─── GET /api/admin/payments/review ───────────────────────────────────────────
// Everything a human needs to look at: stuck pending, amount mismatches,
// successful collections that never landed in a wallet.
const getReviewQueue = async (req, res, next) => {
  try {
    const rows = await listNeedingReview({ limit: Number(req.query.limit) || 100 });
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
};

// ─── GET /api/admin/payments/:referenceId ────────────────────────────────────
// One transaction plus its full event history — the audit trail.
const getPaymentDetail = async (req, res, next) => {
  try {
    const { referenceId } = req.params;
    const txn = await query(
      `SELECT lt.*, lt.amount::float8 AS amount,
              u.first_name, u.last_name, u.email, g.name AS group_name
       FROM lipila_transactions lt
       LEFT JOIN users  u ON u.id = lt.user_id
       LEFT JOIN groups g ON g.id = lt.group_id
       WHERE lt.reference_id = $1`,
      [referenceId]
    );
    if (!txn.rows.length) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    const events = await query(
      `SELECT pe.*, pe.expected_amount::float8 AS expected_amount,
              pe.reported_amount::float8 AS reported_amount,
              a.first_name AS actor_first_name, a.last_name AS actor_last_name
       FROM payment_events pe
       LEFT JOIN users a ON a.id = pe.actor_id
       WHERE pe.reference_id = $1
       ORDER BY pe.created_at ASC`,
      [referenceId]
    );

    // The wallet-side ledger rows this payment produced
    const ledger = await query(
      `SELECT t.id, t.type, t.direction, t.amount::float8 AS amount,
              t.balance_before::float8 AS balance_before,
              t.balance_after::float8 AS balance_after,
              t.status, t.description, t.created_at
       FROM transactions t
       WHERE t.wallet_id = $1 AND t.reference_type IN ('lipila_collection','lipila_reversal')
       ORDER BY t.created_at DESC LIMIT 20`,
      [txn.rows[0].wallet_id]
    );

    res.json({
      success: true,
      data: { transaction: txn.rows[0], events: events.rows, ledger: ledger.rows },
    });
  } catch (err) { next(err); }
};

// ─── POST /api/admin/payments/reconcile ──────────────────────────────────────
// Re-check pending transactions against the provider now, rather than waiting
// for the next sweep. Optional { referenceId } to check just one.
const runReconciliation = async (req, res, next) => {
  try {
    const summary = await reconcilePending({
      source: 'admin',
      referenceId: req.body?.referenceId || null,
      actorId: req.user.id,
    });
    res.json({
      success: true,
      message: `Checked ${summary.checked}, resolved ${summary.resolved}.`,
      data: summary,
    });
  } catch (err) { next(err); }
};

// ─── POST /api/admin/payments/:referenceId/resolve ───────────────────────────
// Manual rectification for cases the provider can't settle for us — e.g. money
// confirmed received out-of-band. Either credits the wallet and marks the
// transaction successful, or writes it off as failed. Always leaves a trail.
const resolveManually = async (req, res, next) => {
  try {
    const { referenceId } = req.params;
    const { action, note } = req.body;

    if (!['credit', 'fail', 'clear_flag'].includes(action)) {
      return res.status(400).json({ success: false, message: 'action must be credit, fail, or clear_flag.' });
    }
    if (!note || !note.trim()) {
      return res.status(400).json({ success: false, message: 'A note explaining the correction is required.' });
    }

    const result = await withTransaction(async (client) => {
      const txnRes = await client.query(
        'SELECT * FROM lipila_transactions WHERE reference_id = $1 FOR UPDATE',
        [referenceId]
      );
      if (!txnRes.rows.length) {
        throw Object.assign(new Error('Transaction not found.'), { status: 404 });
      }
      const txn = txnRes.rows[0];

      if (action === 'clear_flag') {
        await client.query(
          `UPDATE lipila_transactions SET needs_review = FALSE, updated_at = NOW() WHERE id = $1`,
          [txn.id]
        );
        return { txn, credited: false, newStatus: txn.status };
      }

      if (action === 'fail') {
        await client.query(
          `UPDATE lipila_transactions
           SET status = 'failed', needs_review = FALSE, reconciled_at = NOW(),
               reconciliation_source = 'admin', updated_at = NOW()
           WHERE id = $1`,
          [txn.id]
        );
        return { txn, credited: false, newStatus: 'failed' };
      }

      // action === 'credit'
      if (txn.status === 'successful') {
        throw Object.assign(
          new Error('Already marked successful — crediting again would double-count.'),
          { status: 409 }
        );
      }
      if (!txn.wallet_id) {
        throw Object.assign(
          new Error('No wallet linked to this transaction, so there is nothing to credit.'),
          { status: 400 }
        );
      }

      const wRes = await client.query(
        'SELECT balance FROM wallets WHERE id = $1 FOR UPDATE', [txn.wallet_id]
      );
      if (!wRes.rows.length) {
        throw Object.assign(new Error('Linked wallet no longer exists.'), { status: 400 });
      }

      const amount = Number(txn.amount);
      const before = Number(wRes.rows[0].balance);
      const after = before + amount;

      await client.query('UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2',
        [after, txn.wallet_id]);
      await client.query(
        `INSERT INTO transactions
           (wallet_id, type, direction, amount, balance_before, balance_after,
            status, reference_type, description)
         VALUES ($1,'deposit','credit',$2,$3,$4,'completed','lipila_collection',$5)`,
        [txn.wallet_id, amount, before, after, `Manual correction by admin — ${note.trim()}`]
      );
      await client.query(
        `UPDATE lipila_transactions
         SET status = 'successful', needs_review = FALSE, reconciled_at = NOW(),
             reconciliation_source = 'admin', updated_at = NOW()
         WHERE id = $1`,
        [txn.id]
      );

      return { txn, credited: true, newStatus: 'successful', amount };
    });

    res.json({
      success: true,
      message: result.credited
        ? `Wallet credited ${result.amount.toFixed(2)} and transaction marked successful.`
        : action === 'fail'
          ? 'Transaction marked failed.'
          : 'Review flag cleared.',
    });

    await recordPaymentEvent({
      referenceId, txnId: result.txn.id, event: 'manual_resolve', source: 'admin',
      actorId: req.user.id, previousStatus: result.txn.status, newStatus: result.newStatus,
      expectedAmount: Number(result.txn.amount),
      reportedAmount: result.credited ? result.amount : null,
      walletId: result.txn.wallet_id, userId: result.txn.user_id,
      detail: `${action} — ${note.trim()}`,
    });
    logger.warn(`[reconcile] manual "${action}" on ${referenceId} by ${req.user.id}: ${note.trim()}`);
  } catch (err) { next(err); }
};

module.exports = { getReviewQueue, getPaymentDetail, runReconciliation, resolveManually };
