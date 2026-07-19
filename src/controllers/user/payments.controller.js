const crypto  = require('crypto');
const { query, withTransaction } = require('../../config/db');
const lipila   = require('../../services/lipila.service');
const email    = require('../../services/email.service');
const logger   = require('../../config/logger');

// ─── DEPOSIT (MoMo collection) ────────────────────────────────────────────────

// POST /api/payments/deposit
const initiateDeposit = async (req, res, next) => {
  try {
    const { walletId, groupId, amount, mobileNumber } = req.body;

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

    const referenceId = crypto.randomUUID();

    // Record pending transaction before calling Lipila
    await query(
      `INSERT INTO lipila_transactions
         (reference_id, type, status, amount, currency, account_number, narration, wallet_id, user_id, group_id)
       VALUES ($1,'collection','pending',$2,$3,$4,$5,$6,$7,$8)`,
      [referenceId, amount, wallet.currency, mobileNumber,
       `Chilimba wallet top-up`, wallet.id, req.user.id, groupId || null]
    );

    // Call Lipila
    const lipilaRes = await lipila.initiateCollection({
      referenceId,
      amount: parseFloat(amount),
      phone:  mobileNumber,
      narration: 'Chilimba wallet top-up',
      currency: wallet.currency,
      email: req.user.email || '',
    });

    // Store Lipila's identifier
    await query(
      `UPDATE lipila_transactions SET lipila_id = $1 WHERE reference_id = $2`,
      [lipilaRes.identifier || lipilaRes.referenceId || null, referenceId]
    );

    res.json({
      success: true,
      message: 'Payment request sent. Check your phone for a prompt to enter your PIN.',
      data: { referenceId, status: 'pending' },
    });

    // Fire-and-forget — confirm the request to the user
    email.sendDepositInitiated(req.user, {
      referenceId,
      amount,
      mobileNumber,
      currency: wallet.currency,
    }).catch(() => {});
  } catch (err) {
    // Mark failed if Lipila rejected immediately
    if (req.body?.referenceId) {
      query(`UPDATE lipila_transactions SET status='failed' WHERE reference_id=$1`,
        [req.body.referenceId]).catch(() => {});
    }
    next(err);
  }
};

// ─── WEBHOOK (Lipila callback) ─────────────────────────────────────────────────

// POST /api/webhooks/lipila  — public, no auth
const handleWebhook = async (req, res) => {
  try {
    const payload = req.body;
    logger.info(`[lipila webhook] ${JSON.stringify(payload)}`);

    // Lipila sends referenceId = our UUID
    const { referenceId, status, type, amount, identifier, paymentType } = payload;
    if (!referenceId) return res.status(200).json({ received: true });

    // Find our transaction
    const txRes = await query(
      `SELECT * FROM lipila_transactions WHERE reference_id = $1`,
      [referenceId]
    );
    if (!txRes.rows.length) {
      logger.warn(`[lipila webhook] unknown referenceId: ${referenceId}`);
      return res.status(200).json({ received: true });
    }

    const txn = txRes.rows[0];

    // Update transaction record
    await query(
      `UPDATE lipila_transactions
       SET status = $1, lipila_id = COALESCE($2, lipila_id),
           payment_type = COALESCE($3, payment_type),
           webhook_received_at = NOW(), raw_webhook = $4, updated_at = NOW()
       WHERE reference_id = $5`,
      [
        status === 'Successful' ? 'successful' : 'failed',
        identifier || null,
        paymentType || null,
        JSON.stringify(payload),
        referenceId,
      ]
    );

    const successful = status === 'Successful';
    const txnType    = (type || txn.type || '').toLowerCase();

    if (successful && txnType === 'collection' && txn.wallet_id) {
      // Credit the user's wallet
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
           VALUES ($1,'deposit','credit',$2,$3,$4,'completed','lipila_collection',$5)`,
          [txn.wallet_id, amount || txn.amount, before, after,
           `MoMo top-up via ${paymentType || 'mobile money'}`]
        );
      });
      logger.info(`[lipila webhook] wallet ${txn.wallet_id} credited ZMW ${amount}`);
    }

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

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error(`[lipila webhook] error: ${err.message}`);
    res.status(200).json({ received: true }); // always 200 to Lipila
  }
};

// ─── PAYMENT METHODS ─────────────────────────────────────────────────────────

// GET /api/payments/methods
const getPaymentMethods = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT * FROM user_payment_methods WHERE user_id = $1 ORDER BY type`,
      [req.user.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// PUT /api/payments/methods/mobile-money
const saveMobileMoney = async (req, res, next) => {
  try {
    const { mobileNumber, provider } = req.body;
    await query(
      `INSERT INTO user_payment_methods (user_id, type, mobile_number, mobile_provider)
       VALUES ($1, 'mobile_money', $2, $3)
       ON CONFLICT (user_id, type) DO UPDATE
         SET mobile_number   = EXCLUDED.mobile_number,
             mobile_provider = EXCLUDED.mobile_provider,
             updated_at      = NOW()`,
      [req.user.id, mobileNumber, provider]
    );
    res.json({ success: true, message: 'Mobile money details saved.' });
  } catch (err) { next(err); }
};

// PUT /api/payments/methods/bank
const saveBankDetails = async (req, res, next) => {
  try {
    const { bankName, accountNumber, accountName, branch } = req.body;
    await query(
      `INSERT INTO user_payment_methods (user_id, type, bank_name, account_number, account_name, branch)
       VALUES ($1, 'bank', $2, $3, $4, $5)
       ON CONFLICT (user_id, type) DO UPDATE
         SET bank_name      = EXCLUDED.bank_name,
             account_number = EXCLUDED.account_number,
             account_name   = EXCLUDED.account_name,
             branch         = EXCLUDED.branch,
             updated_at     = NOW()`,
      [req.user.id, bankName, accountNumber, accountName, branch || null]
    );
    res.json({ success: true, message: 'Bank details saved.' });
  } catch (err) { next(err); }
};

// GET /api/payments/history
const getPaymentHistory = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT lt.*, w.type AS wallet_type, g.name AS group_name
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
  getPaymentMethods,
  saveMobileMoney,
  saveBankDetails,
  getPaymentHistory,
};
