const { query, withTransaction } = require('../../config/db');
const lipila   = require('../../services/lipila.service');
const email    = require('../../services/email.service');
const logger   = require('../../config/logger');

// ─── DEPOSIT (MoMo collection) ────────────────────────────────────────────────

// POST /api/payments/deposit
const initiateDeposit = async (req, res, next) => {
  // Hoisted so the catch below can resolve the row it created. The previous
  // version read req.body.referenceId, which the client never sends — the
  // server generates it — so a Lipila rejection left the row pending forever.
  let referenceId = null;
  try {
    const { walletId, groupId, amount, method = 'mobile_money' } = req.body;
    let { mobileNumber } = req.body;

    if (method === 'mobile_money') {
      if (!mobileNumber) {
        return res.status(400).json({ success: false, message: 'mobileNumber is required for mobile money deposits.' });
      }
      // Accept 0977123456 / +260 97 712 3456 / etc. and store the canonical
      // 260XXXXXXXXX form — rejecting here avoids leaving a stale pending row.
      const normalized = lipila.normalizeZmPhone(mobileNumber);
      if (!normalized) {
        return res.status(400).json({
          success: false,
          message: 'Enter a valid Zambian mobile number, e.g. 0977123456 or 260977123456.',
        });
      }
      mobileNumber = normalized;
    }

    let wallet;
    if (groupId) {
      // Deposit in the context of a group — find or create the member's group wallet
      const gm = await query(
        `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
        [groupId, req.user.id]
      );
      if (!gm.rows.length) {
        return res.status(403).json({ success: false, message: 'You are not an active member of this group.' });
      }
      const wRes = await query(
        `INSERT INTO wallets (owner_id, type, currency, group_id)
         VALUES ($1, 'group', COALESCE((SELECT currency FROM groups WHERE id = $2), 'ZMW'), $2)
         ON CONFLICT (owner_id, type, group_id) DO UPDATE SET updated_at = NOW()
         RETURNING id, owner_id, type, currency`,
        [req.user.id, groupId]
      );
      wallet = wRes.rows[0];
    } else if (walletId) {
      const walletRes = await query(
        `SELECT id, owner_id, type, currency FROM wallets WHERE id = $1`,
        [walletId]
      );
      if (!walletRes.rows.length || walletRes.rows[0].owner_id !== req.user.id) {
        return res.status(404).json({ success: false, message: 'Wallet not found' });
      }
      wallet = walletRes.rows[0];
    } else {
      return res.status(400).json({ success: false, message: 'walletId or groupId is required.' });
    }

    referenceId = lipila.generateReferenceId();

    // Record pending transaction before calling Lipila
    await query(
      `INSERT INTO lipila_transactions
         (reference_id, type, status, amount, currency, account_number, narration, wallet_id, user_id, group_id, payment_type)
       VALUES ($1,'collection','pending',$2,$3,$4,$5,$6,$7,$8,$9)`,
      [referenceId, amount, wallet.currency, mobileNumber || null,
       `Chilimba wallet top-up`, wallet.id, req.user.id, groupId || null,
       method === 'card' ? 'Card' : null]
    );

    // Call Lipila
    let lipilaRes, paymentUrl = null;
    if (method === 'card') {
      lipilaRes = await lipila.initiateCardCollection({
        referenceId,
        amount: parseFloat(amount),
        narration: 'Chilimba wallet top-up',
        currency: wallet.currency,
        email: req.user.email || '',
        firstName: req.user.first_name,
        lastName: req.user.last_name,
        phone: req.user.phone || '',
      });
      paymentUrl = lipilaRes.paymentUrl;
    } else {
      lipilaRes = await lipila.initiateCollection({
        referenceId,
        amount: parseFloat(amount),
        phone:  mobileNumber,
        narration: 'Chilimba wallet top-up',
        currency: wallet.currency,
        email: req.user.email || '',
      });
    }

    // Store Lipila's identifier
    await query(
      `UPDATE lipila_transactions SET lipila_id = $1 WHERE reference_id = $2`,
      [lipilaRes.identifier || lipilaRes.referenceId || null, referenceId]
    );

    res.json({
      success: true,
      message: method === 'card'
        ? 'Card payment created. Complete your payment on the secure checkout page.'
        : 'Payment request sent. Check your phone for a prompt to enter your PIN.',
      data: { referenceId, status: 'pending', paymentUrl },
    });

    // Fire-and-forget — confirm the request to the user
    email.sendDepositInitiated(req.user, {
      referenceId,
      amount,
      mobileNumber: mobileNumber || 'Card payment',
      currency: wallet.currency,
    }).catch(() => {});
  } catch (err) {
    // Lipila rejected the request (or we never reached it). Close the row we
    // opened so it can't masquerade as money in flight — but only while it is
    // still pending, so we never overwrite a webhook that landed first.
    if (referenceId) {
      query(
        `UPDATE lipila_transactions
         SET status='failed', discrepancy = $2, updated_at = NOW()
         WHERE reference_id = $1 AND status = 'pending'`,
        [referenceId, `Request rejected before reaching the provider: ${err.message}`]
      ).catch(e => logger.error(`[payments] could not fail ${referenceId}: ${e.message}`));
      recordPaymentEvent({
        referenceId, event: 'check_failed', source: 'api', actorId: req.user?.id,
        previousStatus: 'pending', newStatus: 'failed',
        detail: `Provider call failed: ${err.message}`,
      }).catch(() => {});
    }
    next(err);
  }
};

// ─── PAYMENT EVENT LOG ────────────────────────────────────────────────────────
/**
 * Append one row to the money trail. Never throws: an audit write failing must
 * not break, or roll back, an actual payment. Failures are logged loudly
 * instead, because a gap in this log is itself a problem worth seeing.
 */
const recordPaymentEvent = async ({
  referenceId, txnId = null, event, source, actorId = null,
  previousStatus = null, newStatus = null,
  expectedAmount = null, reportedAmount = null,
  walletId = null, userId = null, detail = null, payload = null,
}) => {
  try {
    await query(
      `INSERT INTO payment_events
         (lipila_transaction_id, reference_id, event, source, previous_status, new_status,
          expected_amount, reported_amount, wallet_id, user_id, actor_id, detail, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [txnId, referenceId, event, source, previousStatus, newStatus,
       expectedAmount, reportedAmount, walletId, userId, actorId, detail,
       payload ? JSON.stringify(payload) : null]
    );
  } catch (e) {
    logger.error(`[payment-events] FAILED to record "${event}" for ${referenceId}: ${e.message}`);
  }
};

// ─── SHARED EVENT PROCESSING (webhook + manual status sync) ───────────────────
// Applies a Lipila status payload — { referenceId, status, type, amount,
// identifier, paymentType, ... } — to our ledger. Called both by the webhook
// (payload pushed by Lipila) and by syncTransactionStatus (payload pulled
// from Lipila's check-status endpoint) so both paths share one code path.
const processLipilaEvent = async (payload, { source = 'webhook', actorId = null } = {}) => {
    // Lipila sends referenceId = our UUID
    const { referenceId, status, type, amount, identifier, paymentType } = payload;
    if (!referenceId) return { applied: false, reason: 'missing referenceId' };

    // Lipila's docs say webhooks only fire on a final outcome (Successful or
    // Failed), but in practice a "Pending" status has been observed too —
    // that is NOT final, so it must not be recorded as a failure. Only ever
    // resolve to 'successful' or 'failed'; anything else is left untouched
    // (still pending) so a later, genuinely final event can still land.
    if (status !== 'Successful' && status !== 'Failed') {
      logger.info(`[lipila] non-final status "${status}" for ${referenceId} — leaving as pending`);
      await query(
        `UPDATE lipila_transactions
         SET raw_webhook = $1, last_checked_at = NOW(), check_attempts = check_attempts + 1,
             updated_at = NOW()
         WHERE reference_id = $2`,
        [JSON.stringify(payload), referenceId]
      );
      await recordPaymentEvent({
        referenceId, event: 'status_reported', source, newStatus: 'pending',
        detail: `Non-final status "${status}" — still awaiting a final outcome`,
        payload,
      });
      return { applied: false, reason: 'non-final status' };
    }

    const successful = status === 'Successful';
    const newStatus  = successful ? 'successful' : 'failed';

    // Everything below happens in one transaction so the status flip and the
    // wallet credit cannot come apart, and so a webhook retry racing a manual
    // sync cannot both credit. The UPDATE only matches while the row is still
    // pending — whoever gets there first wins, the loser sees zero rows.
    const result = await withTransaction(async (client) => {
      const claimed = await client.query(
        `UPDATE lipila_transactions
         SET status = $1, lipila_id = COALESCE($2, lipila_id),
             payment_type = COALESCE($3, payment_type),
             webhook_received_at = NOW(), raw_webhook = $4,
             reconciled_at = NOW(), reconciliation_source = $5,
             last_checked_at = NOW(), check_attempts = check_attempts + 1,
             updated_at = NOW()
         WHERE reference_id = $6 AND status = 'pending'
         RETURNING *`,
        [newStatus, identifier || null, paymentType || null,
         JSON.stringify(payload), source, referenceId]
      );

      if (!claimed.rows.length) {
        // Either unknown, or already resolved by a competing caller.
        const existing = await client.query(
          'SELECT id, status FROM lipila_transactions WHERE reference_id = $1', [referenceId]
        );
        if (!existing.rows.length) {
          logger.warn(`[lipila ${source}] unknown referenceId: ${referenceId}`);
          return { applied: false, reason: 'unknown reference' };
        }
        logger.info(`[lipila ${source}] ${referenceId} already ${existing.rows[0].status} — ignoring duplicate`);
        return { applied: false, reason: 'already resolved', duplicate: true, txnId: existing.rows[0].id };
      }

      const txn = claimed.rows[0];
      const txnType = (type || txn.type || '').toLowerCase();

      // What we asked for vs what the provider says it actually moved. Credit
      // the reported figure — that is the real money — but never let a
      // difference pass silently.
      const expected = Number(txn.amount);
      const reported = amount != null && amount !== '' ? Number(amount) : expected;
      const mismatch = Number.isFinite(reported) && Math.abs(reported - expected) > 0.001;
      const creditAmount = Number.isFinite(reported) ? reported : expected;

      if (mismatch) {
        const note = `Provider reported ${reported.toFixed(2)} for a ${expected.toFixed(2)} request`;
        logger.error(`[lipila ${source}] AMOUNT MISMATCH on ${referenceId}: ${note}`);
        await client.query(
          `UPDATE lipila_transactions SET discrepancy = $1, needs_review = TRUE WHERE id = $2`,
          [note, txn.id]
        );
      }

      let credited = false;
      if (successful && txnType === 'collection' && txn.wallet_id) {
        const walletRes = await client.query(
          'SELECT balance FROM wallets WHERE id = $1 FOR UPDATE', [txn.wallet_id]
        );
        if (!walletRes.rows.length) {
          // Money arrived but we have nowhere to put it — must not be silent.
          await client.query(
            `UPDATE lipila_transactions
             SET needs_review = TRUE,
                 discrepancy = COALESCE(discrepancy || ' | ', '') || 'Wallet missing at credit time'
             WHERE id = $1`,
            [txn.id]
          );
        } else {
          const before = Number(walletRes.rows[0].balance);
          const after  = before + creditAmount;
          await client.query(
            'UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2',
            [after, txn.wallet_id]
          );
          await client.query(
            `INSERT INTO transactions
               (wallet_id, type, direction, amount, balance_before, balance_after,
                status, reference_type, description)
             VALUES ($1,'deposit','credit',$2,$3,$4,'completed','lipila_collection',$5)`,
            [txn.wallet_id, creditAmount, before, after,
             `Top-up via ${paymentType || txn.payment_type || 'mobile money'}`]
          );
          credited = true;
          logger.info(`[lipila ${source}] wallet ${txn.wallet_id} credited ${creditAmount} (ref ${referenceId})`);
        }
      } else if (successful && txnType === 'collection' && !txn.wallet_id) {
        await client.query(
          `UPDATE lipila_transactions
           SET needs_review = TRUE,
               discrepancy = COALESCE(discrepancy || ' | ', '') || 'Successful collection with no wallet linked'
           WHERE id = $1`,
          [txn.id]
        );
      }

      return { applied: true, txn, credited, mismatch, creditAmount, expected, reported, txnType };
    });

    // Event log outside the transaction — a logging failure must never roll
    // back a real money movement.
    if (result.applied) {
      await recordPaymentEvent({
        referenceId, txnId: result.txn.id, event: result.credited ? 'credited' : 'status_reported',
        source, actorId, previousStatus: 'pending', newStatus,
        expectedAmount: result.expected, reportedAmount: result.reported,
        walletId: result.txn.wallet_id, userId: result.txn.user_id,
        detail: result.credited
          ? `Credited ${result.creditAmount} to wallet`
          : `Marked ${newStatus}`,
        payload,
      });
      if (result.mismatch) {
        await recordPaymentEvent({
          referenceId, txnId: result.txn.id, event: 'discrepancy', source, actorId,
          expectedAmount: result.expected, reportedAmount: result.reported,
          walletId: result.txn.wallet_id, userId: result.txn.user_id,
          detail: 'Reported amount differs from the requested amount — flagged for review',
          payload,
        });
      }
    } else if (result.duplicate) {
      await recordPaymentEvent({
        referenceId, txnId: result.txnId, event: 'duplicate_ignored', source, actorId,
        detail: `Duplicate ${status} event ignored — already resolved`, payload,
      });
    }

    if (!result.applied) return result;
    const { txn } = result;
    const txnType = result.txnType;

    // ── Email notifications (fire-and-forget) ─────────────────────────────────
    if (txn.user_id) {
      query('SELECT first_name, last_name, email FROM users WHERE id = $1', [txn.user_id])
        .then(({ rows }) => {
          if (!rows.length) return;
          const user = rows[0];
          const txnAmt    = amount || txn.amount;
          const txnCur    = txn.currency || 'ZMW';
          const lipilaId  = identifier || txn.lipila_id;

          if (txnType === 'collection') {
            if (successful) {
              email.sendDepositConfirmed(user, { referenceId, lipilaId, amount: txnAmt, currency: txnCur, paymentType }).catch(() => {});

              // Alert all platform admins of the incoming deposit
              query(`SELECT email, first_name FROM users WHERE role IN ('admin','super_admin') AND status = 'active'`)
                .then(({ rows: admins }) => {
                  const memberName = `${user.first_name} ${user.last_name}`;
                  for (const admin of admins) {
                    email.sendAdminPaymentAlert(admin.email, admin.first_name, {
                      type: 'deposit', memberName, referenceId, lipilaId,
                      amount: txnAmt, currency: txnCur, status: 'successful',
                    }).catch(() => {});
                  }
                }).catch(() => {});
            } else {
              email.sendDepositFailed(user, { referenceId, lipilaId, amount: txnAmt, currency: txnCur }).catch(() => {});
            }
          }
        }).catch(() => {});
    }

    if (!successful && txnType === 'disbursement' && txn.user_id) {
      // Alert admins that a MoMo payout bounced
      query('SELECT first_name, last_name FROM users WHERE id = $1', [txn.user_id])
        .then(({ rows: uRows }) => {
          const memberName = uRows.length ? `${uRows[0].first_name} ${uRows[0].last_name}` : 'Unknown';
          return query(`SELECT email, first_name FROM users WHERE role IN ('admin','super_admin') AND status = 'active'`)
            .then(({ rows: admins }) => {
              for (const admin of admins) {
                email.sendAdminPaymentAlert(admin.email, admin.first_name, {
                  type: 'payout', memberName,
                  referenceId, lipilaId: identifier || txn.lipila_id,
                  amount: amount || txn.amount, currency: txn.currency || 'ZMW',
                  status: 'failed',
                  detail: 'MoMo disbursement failed — amount reversed to group wallet.',
                }).catch(() => {});
              }
            });
        }).catch(() => {});
    }

    if (!successful && txnType === 'disbursement' && txn.wallet_id) {
      // Reverse the debit — payout failed
      await withTransaction(async (client) => {
        const walletRes = await client.query(
          `SELECT balance FROM wallets WHERE id = $1 FOR UPDATE`, [txn.wallet_id]
        );
        const before = parseFloat(walletRes.rows[0]?.balance || 0);
        const after  = before + parseFloat(amount || txn.amount);
        await client.query(
          `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
          [after, txn.wallet_id]
        );
        await client.query(
          `INSERT INTO transactions
             (wallet_id, type, direction, amount, balance_before, balance_after,
              status, reference_type, description)
           VALUES ($1,'reversal','credit',$2,$3,$4,'completed','lipila_reversal',$5)`,
          [txn.wallet_id, amount || txn.amount, before, after, 'Disbursement failed — amount reversed']
        );
      });
      logger.warn(`[lipila webhook] disbursement failed, reversed wallet ${txn.wallet_id}`);
    }
};

// ─── WEBHOOK (Lipila callback) ─────────────────────────────────────────────────
// Docs: https://docs.lipila.dev/docs/billing/webhook.html
// POST /api/webhooks/lipila  — public, no auth. Always respond 200 so Lipila
// doesn't retry — failures are logged, not surfaced to the caller.
const handleWebhook = async (req, res) => {
  try {
    logger.info(`[lipila webhook] ${JSON.stringify(req.body)}`);
    await processLipilaEvent(req.body, { source: 'webhook' });
  } catch (err) {
    logger.error(`[lipila webhook] error: ${err.message}`);
  } finally {
    res.status(200).json({ received: true });
  }
};

// ─── MANUAL STATUS SYNC ────────────────────────────────────────────────────────
// POST /api/payments/sync-status  { referenceId }
// Manually re-check a pending transaction's status with Lipila — collections
// via /collections/check-status, disbursements via /disbursements/check-status.
// Useful when a webhook is delayed or missed.
const syncTransactionStatus = async (req, res, next) => {
  try {
    const { referenceId } = req.body;
    const txRes = await query(`SELECT * FROM lipila_transactions WHERE reference_id = $1`, [referenceId]);
    if (!txRes.rows.length) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }
    const txn = txRes.rows[0];

    const isOwner = txn.user_id === req.user.id;
    const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this transaction.' });
    }

    if (txn.status !== 'pending') {
      return res.json({ success: true, message: 'Transaction already resolved.', data: { status: txn.status } });
    }

    let statusRes;
    try {
      statusRes = txn.type === 'disbursement'
        ? await lipila.checkDisbursementStatus(referenceId)
        : await lipila.checkCollectionStatus(referenceId);
    } catch (e) {
      if (e.statusCode === 404) {
        // Endpoint not available on the configured LIPILA_API_URL for this
        // transaction type — nothing to do but wait for the webhook.
        return res.json({
          success: true,
          message: 'Status check is not available right now — this will update automatically once Lipila sends the webhook confirmation.',
          data: { status: txn.status },
        });
      }
      throw e;
    }

    await processLipilaEvent(
      { ...statusRes, referenceId },
      { source: 'sync', actorId: req.user.id }
    );

    const updated = await query(`SELECT status FROM lipila_transactions WHERE reference_id = $1`, [referenceId]);
    res.json({ success: true, message: 'Status refreshed from Lipila.', data: { status: updated.rows[0].status } });
  } catch (err) { next(err); }
};

// ─── PAYMENT METHODS ─────────────────────────────────────────────────────────

// GET /api/payments/methods
const getPaymentMethods = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, user_id AS "userId", type,
              mobile_number AS "mobileNumber", mobile_provider AS "mobileProvider",
              bank_name AS "bankName", account_number AS "accountNumber",
              account_name AS "accountName", branch, swift_code AS "swiftCode",
              is_default AS "isDefault", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM user_payment_methods WHERE user_id = $1 ORDER BY type`,
      [req.user.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// PUT /api/payments/methods/mobile-money
const saveMobileMoney = async (req, res, next) => {
  try {
    const { mobileNumber, provider } = req.body;
    // Payouts are sent to this number, so store it in the form Lipila accepts.
    const normalized = lipila.normalizeZmPhone(mobileNumber);
    if (!normalized) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid Zambian mobile number, e.g. 0977123456 or 260977123456.',
      });
    }
    await query(
      `INSERT INTO user_payment_methods (user_id, type, mobile_number, mobile_provider)
       VALUES ($1, 'mobile_money', $2, $3)
       ON CONFLICT (user_id, type) DO UPDATE
         SET mobile_number   = EXCLUDED.mobile_number,
             mobile_provider = EXCLUDED.mobile_provider,
             updated_at      = NOW()`,
      [req.user.id, normalized, provider]
    );
    res.json({ success: true, message: 'Mobile money details saved.' });
  } catch (err) { next(err); }
};

// PUT /api/payments/methods/bank
const saveBankDetails = async (req, res, next) => {
  try {
    const { bankName, accountNumber, accountName, branch, swiftCode } = req.body;
    await query(
      `INSERT INTO user_payment_methods (user_id, type, bank_name, account_number, account_name, branch, swift_code)
       VALUES ($1, 'bank', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, type) DO UPDATE
         SET bank_name      = EXCLUDED.bank_name,
             account_number = EXCLUDED.account_number,
             account_name   = EXCLUDED.account_name,
             branch         = EXCLUDED.branch,
             swift_code     = EXCLUDED.swift_code,
             updated_at     = NOW()`,
      [req.user.id, bankName, accountNumber, accountName, branch || null, swiftCode || null]
    );
    res.json({ success: true, message: 'Bank details saved.' });
  } catch (err) { next(err); }
};

// GET /api/payments/history
const getPaymentHistory = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT lt.id, lt.reference_id AS "referenceId", lt.lipila_id AS "lipilaId",
              lt.type, lt.status, lt.amount, lt.currency,
              lt.account_number AS "accountNumber", lt.payment_type AS "paymentType",
              lt.narration, lt.wallet_id AS "walletId", lt.user_id AS "userId",
              lt.group_id AS "groupId", g.name AS "groupName",
              lt.created_at AS "createdAt", lt.updated_at AS "updatedAt"
       FROM lipila_transactions lt
       LEFT JOIN wallets w ON w.id = lt.wallet_id
       LEFT JOIN groups  g ON g.id = lt.group_id
       WHERE lt.user_id = $1
       ORDER BY lt.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

module.exports = {
  initiateDeposit,
  handleWebhook,
  syncTransactionStatus,
  getPaymentMethods,
  saveMobileMoney,
  saveBankDetails,
  getPaymentHistory,
  // Used by the reconciliation sweep so pulled statuses go through exactly the
  // same atomic path as pushed webhooks.
  processLipilaEvent,
  recordPaymentEvent,
};
