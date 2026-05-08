const { query, withTransaction } = require('../config/db');
const { notifyGroup, notify } = require('./notification.service');

/**
 * Generate payout schedule for a new cycle.
 * Assigns each active member one round in random/assigned order.
 */
const generatePayoutSchedule = async (client, groupId, cycleNumber, payoutDay) => {
  const members = await client.query(
    `SELECT user_id, payout_order FROM group_members
     WHERE group_id = $1 AND status = 'active'
     ORDER BY payout_order ASC NULLS LAST, joined_at ASC`,
    [groupId]
  );

  for (let i = 0; i < members.rows.length; i++) {
    const member = members.rows[i];
    // Calculate payout date: month i+1 of the cycle, on payout_day
    const payoutDate = new Date();
    payoutDate.setDate(payoutDay);
    payoutDate.setMonth(payoutDate.getMonth() + i);
    payoutDate.setHours(0, 0, 0, 0);

    const group = await client.query(
      'SELECT monthly_amount, max_members FROM groups WHERE id = $1',
      [groupId]
    );
    const { monthly_amount, max_members } = group.rows[0];

    await client.query(
      `INSERT INTO payout_schedule (group_id, user_id, cycle_number, payout_order, scheduled_date, expected_amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (group_id, cycle_number, payout_order) DO NOTHING`,
      [groupId, member.user_id, cycleNumber, i + 1, payoutDate, monthly_amount * max_members]
    );
  }
};

/**
 * Generate contribution records for a new round (month).
 */
const generateContributionRound = async (client, groupId, cycleNumber, roundNumber, contributionDay) => {
  const members = await client.query(
    `SELECT user_id FROM group_members WHERE group_id = $1 AND status = 'active'`,
    [groupId]
  );
  const group = await client.query(
    'SELECT monthly_amount FROM groups WHERE id = $1',
    [groupId]
  );
  const { monthly_amount } = group.rows[0];

  const dueDate = new Date();
  dueDate.setDate(contributionDay);
  dueDate.setHours(23, 59, 59, 0);

  for (const member of members.rows) {
    const ref = `CHI-${groupId.slice(0, 8)}-${cycleNumber}-${roundNumber}-${member.user_id.slice(0, 8)}`.toUpperCase();
    await client.query(
      `INSERT INTO contributions
         (group_id, user_id, cycle_number, round_number, amount_due, due_date, reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (group_id, user_id, cycle_number, round_number) DO NOTHING`,
      [groupId, member.user_id, cycleNumber, roundNumber, monthly_amount, dueDate, ref]
    );
  }
};

/**
 * Record a contribution payment and credit the group wallet.
 * Handles fee deduction and transaction ledger.
 */
const recordContribution = async (contributionId, payerUserId, ipAddress) => {
  return withTransaction(async (client) => {
    // Lock contribution
    const contribResult = await client.query(
      `SELECT c.*, g.id AS group_id, g.name AS group_name
       FROM contributions c JOIN groups g ON g.id = c.group_id
       WHERE c.id = $1 AND c.user_id = $2
       FOR UPDATE`,
      [contributionId, payerUserId]
    );
    if (!contribResult.rows.length) throw Object.assign(new Error('Contribution not found'), { status: 404 });

    const contrib = contribResult.rows[0];
    if (contrib.status === 'paid') throw Object.assign(new Error('Already paid'), { status: 409 });

    // Get or create group wallet
    const walletResult = await client.query(
      `INSERT INTO wallets (owner_id, type, group_id, currency)
       VALUES ($1, 'group', $2, 'ZMW')
       ON CONFLICT (owner_id, type, group_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [payerUserId, contrib.group_id]
    );
    const wallet = walletResult.rows[0];

    // Fetch fee config
    const feeResult = await client.query(
      `SELECT * FROM fees_config WHERE applies_to = 'contribution' AND is_active = TRUE LIMIT 1`
    );
    const feeConfig = feeResult.rows[0];
    const feeAmount = feeConfig
      ? feeConfig.fee_type === 'percentage'
        ? Number(contrib.amount_due) * (Number(feeConfig.value) / 100)
        : Number(feeConfig.value)
      : 0;

    const netAmount = Number(contrib.amount_due) - feeAmount;

    // Credit group wallet
    await client.query(
      `UPDATE wallets SET balance = balance + $1 WHERE id = $2`,
      [netAmount, wallet.id]
    );

    // Transaction record
    await client.query(
      `INSERT INTO transactions (wallet_id, type, direction, amount, balance_before, balance_after,
         status, reference_id, reference_type, description)
       VALUES ($1, 'contribution', 'credit', $2, $3, $3 + $2, 'completed', $4, 'contribution', $5)`,
      [wallet.id, netAmount, wallet.balance, contrib.id, `Contribution - Cycle ${contrib.cycle_number} Rd ${contrib.round_number}`]
    );

    // Fee transaction
    if (feeAmount > 0) {
      await client.query(
        `INSERT INTO transactions (wallet_id, type, direction, amount, balance_before, balance_after,
           status, reference_id, reference_type, description)
         VALUES ($1, 'fee', 'debit', $2, $3, $3 - $2, 'completed', $4, 'contribution', 'Platform fee')`,
        [wallet.id, feeAmount, wallet.balance + netAmount, contrib.id]
      );
    }

    const isLate = new Date() > new Date(contrib.due_date);

    // Mark contribution paid
    await client.query(
      `UPDATE contributions
       SET status = $1, amount_paid = amount_due, paid_at = NOW(), late_fee_charged = $2
       WHERE id = $3`,
      [isLate ? 'late' : 'paid', feeAmount, contributionId]
    );

    // Audit
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, ip_address)
       VALUES ($1, 'contribution_recorded', 'contribution', $2, $3)`,
      [payerUserId, contributionId, ipAddress]
    );

    // Notify group
    await notifyGroup(
      contrib.group_id,
      'contribution_received',
      `${contrib.group_name} – Contribution Received`,
      `A member has paid their contribution for Round ${contrib.round_number}.`,
      { contributionId },
      payerUserId
    );

    return { contribution: contrib, feeCharged: feeAmount, netAmount };
  });
};

/**
 * Disburse the scheduled payout for the current round to the recipient.
 */
const disbursePayout = async (payoutScheduleId, adminUserId) => {
  return withTransaction(async (client) => {
    const schedResult = await client.query(
      `SELECT ps.*, g.monthly_amount, g.max_members, g.name AS group_name,
              u.first_name || ' ' || u.last_name AS recipient_name
       FROM payout_schedule ps
       JOIN groups g ON g.id = ps.group_id
       JOIN users u ON u.id = ps.user_id
       WHERE ps.id = $1 AND ps.status = 'scheduled'
       FOR UPDATE`,
      [payoutScheduleId]
    );
    if (!schedResult.rows.length) throw Object.assign(new Error('Payout not found or already processed'), { status: 404 });

    const sched = schedResult.rows[0];

    // Get recipient personal wallet
    const walletResult = await client.query(
      `INSERT INTO wallets (owner_id, type, currency)
       VALUES ($1, 'personal', 'ZMW')
       ON CONFLICT (owner_id, type, group_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [sched.user_id]
    );
    const wallet = walletResult.rows[0];

    // Fee on payout
    const feeResult = await client.query(
      `SELECT * FROM fees_config WHERE applies_to = 'payout' AND is_active = TRUE LIMIT 1`
    );
    const feeConfig = feeResult.rows[0];
    const feeAmount = feeConfig
      ? feeConfig.fee_type === 'percentage'
        ? Number(sched.expected_amount) * (Number(feeConfig.value) / 100)
        : Number(feeConfig.value)
      : 0;

    const netPayout = Number(sched.expected_amount) - feeAmount;

    // Credit personal wallet
    await client.query(
      'UPDATE wallets SET balance = balance + $1 WHERE id = $2',
      [netPayout, wallet.id]
    );

    // Transaction
    await client.query(
      `INSERT INTO transactions (wallet_id, type, direction, amount, balance_before, balance_after,
         status, reference_id, reference_type, description)
       VALUES ($1, 'payout', 'credit', $2, $3, $3 + $2, 'completed', $4, 'payout_schedule', $5)`,
      [wallet.id, netPayout, wallet.balance, sched.id, `Chilimba payout – ${sched.group_name} Cycle ${sched.cycle_number}`]
    );

    // Update schedule
    await client.query(
      `UPDATE payout_schedule
       SET status = 'completed', actual_amount = $1, paid_at = NOW()
       WHERE id = $2`,
      [netPayout, payoutScheduleId]
    );

    // Audit
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
       VALUES ($1, 'payout_disbursed', 'payout_schedule', $2)`,
      [adminUserId, payoutScheduleId]
    );

    // Notify recipient + group
    await notify(
      sched.user_id,
      'payout_disbursed',
      `🎉 Your Chilimba Payout – ${sched.group_name}`,
      `ZMW ${netPayout.toFixed(2)} has been credited to your wallet.`,
      { amount: netPayout, groupId: sched.group_id }
    );
    await notifyGroup(
      sched.group_id,
      'payout_scheduled',
      `${sched.group_name} – Payout Disbursed`,
      `This month's payout has been disbursed to ${sched.recipient_name}.`,
      {},
      sched.user_id
    );

    return { payout: sched, netPayout, feeCharged: feeAmount };
  });
};

module.exports = { generatePayoutSchedule, generateContributionRound, recordContribution, disbursePayout };
