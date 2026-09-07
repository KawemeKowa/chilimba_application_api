const { query, withTransaction } = require('../../config/db');
const { getOrCreatePersonalWallet, getOrCreateGroupWallet } = require('../../services/wallet.service');
const { notify } = require('../../services/notification.service');
const lipila = require('../../services/lipila.service');
const logger = require('../../config/logger');

// ─── POST /api/wallet/transfer ────────────────────────────────────────────────
// Move money from the personal wallet into one of the user's group wallets.
// { groupId, amount }
const transferToGroup = async (req, res, next) => {
  try {
    const { groupId } = req.body;
    const amount = Number(req.body.amount);

    if (!groupId) {
      return res.status(400).json({ success: false, message: 'groupId is required.' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Enter an amount greater than zero.' });
    }

    const membership = await query(
      `SELECT g.name, g.currency
       FROM group_members gm JOIN groups g ON g.id = gm.group_id
       WHERE gm.group_id = $1 AND gm.user_id = $2 AND gm.status = 'active'`,
      [groupId, req.user.id]
    );
    if (!membership.rows.length) {
      return res.status(403).json({ success: false, message: 'You are not an active member of this group.' });
    }
    const group = membership.rows[0];

    const result = await withTransaction(async (client) => {
      const exec = client.query.bind(client);

      // Lock both wallets. Personal first, consistently, so two concurrent
      // transfers can't deadlock by grabbing them in opposite orders.
      const personal = await getOrCreatePersonalWallet(exec, req.user.id, { forUpdate: true });
      const groupWallet = await getOrCreateGroupWallet(exec, req.user.id, groupId, { forUpdate: true });

      const personalBalance = Number(personal.balance);
      if (personalBalance + 0.001 < amount) {
        throw Object.assign(new Error(
          `Insufficient balance. Your personal wallet holds ${group.currency || 'ZMW'} ${personalBalance.toFixed(2)}.`
        ), { status: 400 });
      }

      const groupBalance = Number(groupWallet.balance);

      await exec('UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
        [amount, personal.id]);
      await exec('UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
        [amount, groupWallet.id]);

      // Both legs of the move, so each wallet's history reads correctly
      await exec(
        `INSERT INTO transactions (wallet_id, type, direction, amount, balance_before, balance_after,
           status, reference_id, reference_type, description)
         VALUES ($1, 'transfer', 'debit', $2, $3, $3::numeric - $2::numeric, 'completed', $4, 'wallet_transfer', $5)`,
        [personal.id, amount, personalBalance, groupId, `Sent to ${group.name}`]
      );
      await exec(
        `INSERT INTO transactions (wallet_id, type, direction, amount, balance_before, balance_after,
           status, reference_id, reference_type, description)
         VALUES ($1, 'transfer', 'credit', $2, $3, $3::numeric + $2::numeric, 'completed', $4, 'wallet_transfer', $5)`,
        [groupWallet.id, amount, groupBalance, groupId, 'Received from personal wallet']
      );

      await exec(
        `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, changes)
         VALUES ($1, 'wallet_transfer', 'wallet', $2, $3)`,
        [req.user.id, groupWallet.id, JSON.stringify({ groupId, amount })]
      ).catch(() => {});

      return {
        amount,
        currency: group.currency || 'ZMW',
        groupName: group.name,
        personalBalance: personalBalance - amount,
        groupBalance: groupBalance + amount,
      };
    });

    res.json({
      success: true,
      message: `${result.currency} ${result.amount.toFixed(2)} sent to ${result.groupName}.`,
      data: result,
    });
  } catch (err) { next(err); }
};

// ─── POST /api/wallet/withdraw ────────────────────────────────────────────────
// Cash out from the personal wallet to mobile money or bank.
// { amount, destination: 'mobile_money' | 'bank' }
const withdrawToBank = async (req, res, next) => {
  try {
    const amount = Number(req.body.amount);
    const destination = req.body.destination || 'mobile_money';

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Enter an amount greater than zero.' });
    }
    if (!['mobile_money', 'bank'].includes(destination)) {
      return res.status(400).json({ success: false, message: 'Choose either mobile money or bank.' });
    }

    // Where the money is going — saved on the profile
    const methods = await query(
      `SELECT type, mobile_number, bank_name, account_number, account_name, swift_code
       FROM user_payment_methods WHERE user_id = $1`,
      [req.user.id]
    );
    const momo = methods.rows.find(m => m.type === 'mobile_money');
    const bank = methods.rows.find(m => m.type === 'bank');

    if (destination === 'mobile_money' && !momo?.mobile_number) {
      return res.status(400).json({
        success: false,
        message: 'Add your mobile money number in Profile before withdrawing.',
      });
    }
    if (destination === 'bank' && !(bank?.account_number && bank?.swift_code)) {
      return res.status(400).json({
        success: false,
        message: 'Add your bank account number and SWIFT code in Profile before withdrawing.',
      });
    }

    const referenceId = lipila.generateReferenceId();

    // Debit first, inside a transaction, so the balance can't be spent twice
    // by two concurrent withdrawals. Reversed below if Lipila rejects it.
    const debited = await withTransaction(async (client) => {
      const exec = client.query.bind(client);
      const wallet = await getOrCreatePersonalWallet(exec, req.user.id, { forUpdate: true });
      const balance = Number(wallet.balance);

      if (balance + 0.001 < amount) {
        throw Object.assign(new Error(
          `Insufficient balance. Your personal wallet holds ${wallet.currency || 'ZMW'} ${balance.toFixed(2)}.`
        ), { status: 400 });
      }

      await exec('UPDATE wallets SET balance = balance - $1, updated_at = NOW() WHERE id = $2',
        [amount, wallet.id]);
      await exec(
        `INSERT INTO transactions (wallet_id, type, direction, amount, balance_before, balance_after,
           status, reference_type, description)
         VALUES ($1, 'withdrawal', 'debit', $2, $3, $3::numeric - $2::numeric, 'pending', 'wallet_withdrawal', $4)`,
        [wallet.id, amount, balance,
         destination === 'bank' ? 'Withdrawal to bank account' : 'Withdrawal to mobile money']
      );

      const accountNumber = destination === 'bank' ? bank.account_number : momo.mobile_number;
      await exec(
        `INSERT INTO lipila_transactions
           (reference_id, type, status, amount, currency, account_number, narration,
            wallet_id, user_id, payment_type)
         VALUES ($1,'disbursement','pending',$2,$3,$4,$5,$6,$7,$8)`,
        [referenceId, amount, wallet.currency || 'ZMW', accountNumber,
         'Chilimba wallet withdrawal', wallet.id, req.user.id,
         destination === 'bank' ? 'Bank' : 'MoMo']
      );

      return { walletId: wallet.id, currency: wallet.currency || 'ZMW', balanceAfter: balance - amount };
    });

    // Hand off to Lipila. On immediate rejection, put the money back — the
    // webhook handles later failures via the existing reversal path.
    try {
      const lipilaRes = destination === 'bank'
        ? await lipila.initiateBankDisbursement({
            referenceId, amount, currency: debited.currency,
            narration: 'Chilimba wallet withdrawal',
            accountNumber: bank.account_number,
            swiftCode: bank.swift_code,
            firstName: req.user.first_name,
            lastName: req.user.last_name,
            accountHolderName: bank.account_name || `${req.user.first_name} ${req.user.last_name}`,
            phoneNumber: req.user.phone || '',
            email: req.user.email || '',
          })
        : await lipila.initiateDisbursement({
            referenceId, amount, phone: momo.mobile_number,
            narration: 'Chilimba wallet withdrawal',
            currency: debited.currency,
          });

      await query('UPDATE lipila_transactions SET lipila_id = $1 WHERE reference_id = $2',
        [lipilaRes.identifier || lipilaRes.referenceId || null, referenceId]);
    } catch (e) {
      logger.error(`[lipila] withdrawal ${referenceId} rejected: ${e.message}`);
      await reverseWithdrawal(debited.walletId, amount, referenceId);
      return res.status(502).json({
        success: false,
        message: `Withdrawal could not be sent: ${e.message} Your balance has not been changed.`,
      });
    }

    notify(
      req.user.id, 'system', 'Withdrawal on its way',
      `${debited.currency} ${amount.toFixed(2)} is being sent to your ${destination === 'bank' ? 'bank account' : 'mobile money'}.`,
      { referenceId }
    ).catch(() => {});

    res.json({
      success: true,
      message: destination === 'bank'
        ? 'Withdrawal sent to your bank account. Bank transfers can take 1–3 business days.'
        : 'Withdrawal sent to your mobile money account.',
      data: { referenceId, amount, balance: debited.balanceAfter, currency: debited.currency },
    });
  } catch (err) { next(err); }
};

/** Put a failed withdrawal back on the wallet and mark the records failed. */
async function reverseWithdrawal(walletId, amount, referenceId) {
  try {
    await withTransaction(async (client) => {
      const exec = client.query.bind(client);
      const w = await exec('SELECT balance FROM wallets WHERE id = $1 FOR UPDATE', [walletId]);
      const before = Number(w.rows[0]?.balance || 0);

      await exec('UPDATE wallets SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
        [amount, walletId]);
      await exec(
        `INSERT INTO transactions (wallet_id, type, direction, amount, balance_before, balance_after,
           status, reference_type, description)
         VALUES ($1, 'refund', 'credit', $2, $3, $3::numeric + $2::numeric, 'completed', 'wallet_withdrawal',
                 'Withdrawal failed — amount returned')`,
        [walletId, amount, before]
      );
      await exec(
        `UPDATE transactions SET status = 'failed'
         WHERE wallet_id = $1 AND reference_type = 'wallet_withdrawal' AND status = 'pending'`,
        [walletId]
      );
      await exec(`UPDATE lipila_transactions SET status = 'failed', updated_at = NOW()
                  WHERE reference_id = $1`, [referenceId]);
    });
  } catch (e) {
    logger.error(`[wallet] reversal failed for ${referenceId}: ${e.message} — needs manual correction`);
  }
}

module.exports = { transferToGroup, withdrawToBank };
