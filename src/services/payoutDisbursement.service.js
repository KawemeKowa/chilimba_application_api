const crypto  = require('crypto');
const { query } = require('../config/db');
const lipila  = require('./lipila.service');
const email   = require('./email.service');
const logger  = require('../config/logger');

/**
 * After the internal ledger credit (disbursePayout) has already run, send the
 * actual money out via Lipila:
 *   1. Mobile money, if the recipient has a number on file
 *   2. Bank transfer, if they have bank details with a SWIFT/BIC code
 *   3. Otherwise the wallet was credited but no external payout is possible —
 *      the recipient is notified but an admin must arrange payment manually.
 * Always fire-and-forget; caller has already responded to the HTTP request.
 */
async function sendPayoutViaLipila({ payout, netPayout, groupId }) {
  const { rows } = await query(
    `SELECT u.first_name, u.last_name, u.email, u.phone,
            momo.mobile_number, momo.mobile_provider,
            bank.account_number AS bank_account_number,
            bank.account_name   AS bank_account_name,
            bank.swift_code
     FROM users u
     LEFT JOIN user_payment_methods momo ON momo.user_id = u.id AND momo.type = 'mobile_money'
     LEFT JOIN user_payment_methods bank ON bank.user_id = u.id AND bank.type = 'bank'
     WHERE u.id = $1`,
    [payout.user_id]
  );
  if (!rows.length) return;
  const user = rows[0];
  const groupName = payout.group_name;

  if (user.mobile_number) {
    const referenceId = crypto.randomUUID();
    email.sendPayoutDisbursed(user, payout, { name: groupName, id: groupId }, referenceId).catch(() => {});
    try {
      const lipilaRes = await lipila.initiateDisbursement({
        referenceId, amount: netPayout, phone: user.mobile_number,
        narration: `Chilimba payout – ${groupName}`,
      });
      await recordDisbursementTxn({
        referenceId, lipilaId: lipilaRes.identifier, netPayout, groupName, groupId,
        accountNumber: user.mobile_number, paymentType: 'MoMo', userId: payout.user_id,
      });
    } catch (e) {
      logger.error(`[lipila] MoMo disbursement failed: ${e.message}`);
    }
    return;
  }

  if (user.bank_account_number && user.swift_code) {
    const referenceId = crypto.randomUUID();
    email.sendPayoutDisbursed(user, payout, { name: groupName, id: groupId }, referenceId).catch(() => {});
    try {
      const lipilaRes = await lipila.initiateBankDisbursement({
        referenceId, amount: netPayout, currency: payout.currency || 'ZMW',
        narration: `Chilimba payout – ${groupName}`,
        accountNumber: user.bank_account_number,
        swiftCode: user.swift_code,
        firstName: user.first_name,
        lastName: user.last_name,
        accountHolderName: user.bank_account_name || `${user.first_name} ${user.last_name}`,
        phoneNumber: user.phone || '',
        email: user.email || '',
      });
      await recordDisbursementTxn({
        referenceId, lipilaId: lipilaRes.identifier, netPayout, groupName, groupId,
        accountNumber: user.bank_account_number, paymentType: 'Bank', userId: payout.user_id,
      });
    } catch (e) {
      logger.error(`[lipila] Bank disbursement failed: ${e.message}`);
    }
    return;
  }

  logger.warn(`[lipila] user ${payout.user_id} has no mobile money or bank details on file — wallet credited only`);
  email.sendPayoutDisbursed(user, payout, { name: groupName, id: groupId }).catch(() => {});
}

async function recordDisbursementTxn({ referenceId, lipilaId, netPayout, groupName, groupId, accountNumber, paymentType, userId }) {
  const wRes = await query(
    `SELECT id FROM wallets WHERE owner_id = $1 AND type = 'personal' AND group_id IS NULL LIMIT 1`,
    [userId]
  );
  await query(
    `INSERT INTO lipila_transactions
       (reference_id, lipila_id, type, status, amount, account_number, narration, wallet_id, user_id, group_id, payment_type)
     VALUES ($1,$2,'disbursement','pending',$3,$4,$5,$6,$7,$8,$9)`,
    [referenceId, lipilaId || null, netPayout, accountNumber,
     `Chilimba payout – ${groupName}`, wRes.rows[0]?.id || null, userId, groupId, paymentType]
  ).catch(e => logger.error(`[lipila] failed to record disbursement txn: ${e.message}`));
}

module.exports = { sendPayoutViaLipila };
