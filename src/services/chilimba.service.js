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
      'SELECT monthly_amount FROM groups WHERE id = $1',
      [groupId]
    );
    const { monthly_amount } = group.rows[0];

    // Expected pot for a round = each active member's monthly contribution.
    // (Previously this used max_members, which produced absurd amounts for
    // groups with a large member cap.)
    const expectedPot = Number(monthly_amount) * members.rows.length;

    await client.query(
      `INSERT INTO payout_schedule (group_id, user_id, cycle_number, payout_order, scheduled_date, expected_amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (group_id, cycle_number, payout_order) DO NOTHING`,
      [groupId, member.user_id, cycleNumber, i + 1, payoutDate, expectedPot]
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
 * Enroll a newly-joined member into the group's current cycle: give them a
 * contribution obligation and a slot at the end of the payout schedule.
 * No-ops on the schedule if it's already locked (post-first-payout).
 * `exec` is a querier (the pool's `query` or a transaction client's `query`).
 */
const enrollMemberInCycle = async (exec, groupId, userId) => {
  const gRes = await exec(
    `SELECT monthly_amount, current_cycle, contribution_day, payout_day, schedule_locked
     FROM groups WHERE id = $1`,
    [groupId]
  );
  if (!gRes.rows.length) return;
  const g = gRes.rows[0];
  const cycle = g.current_cycle || 1;

  // Contribution for the current cycle / round 1
  const dueDate = new Date();
  dueDate.setDate(g.contribution_day || 1);
  dueDate.setHours(23, 59, 59, 0);
  const ref = `CHI-${groupId.slice(0, 8)}-${cycle}-1-${userId.slice(0, 8)}`.toUpperCase();
  await exec(
    `INSERT INTO contributions
       (group_id, user_id, cycle_number, round_number, amount_due, due_date, reference)
     VALUES ($1, $2, $3, 1, $4, $5, $6)
     ON CONFLICT (group_id, user_id, cycle_number, round_number) DO NOTHING`,
    [groupId, userId, cycle, g.monthly_amount, dueDate, ref]
  );

  // Append to the payout schedule (unless locked)
  if (!g.schedule_locked) {
    const ordRes = await exec(
      `SELECT COALESCE(MAX(payout_order), 0) + 1 AS next FROM payout_schedule
       WHERE group_id = $1 AND cycle_number = $2`,
      [groupId, cycle]
    );
    const order = ordRes.rows[0].next;
    const payoutDate = new Date();
    payoutDate.setDate(g.payout_day || 25);
    payoutDate.setMonth(payoutDate.getMonth() + order - 1);
    payoutDate.setHours(0, 0, 0, 0);
    // expected_amount is refreshed for the whole cycle below
    await exec(
      `INSERT INTO payout_schedule (group_id, user_id, cycle_number, payout_order, scheduled_date, expected_amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (group_id, cycle_number, payout_order) DO NOTHING`,
      [groupId, userId, cycle, order, payoutDate, g.monthly_amount]
    );
    // Refresh every scheduled row's expected pot = monthly × active members.
    // COUNT() is bigint; cast monthly_amount to numeric so "500.00" isn't
    // coerced to bigint (which rejects the decimals).
    await exec(
      `UPDATE payout_schedule ps
       SET expected_amount = $2::numeric * (SELECT COUNT(*) FROM group_members
                                   WHERE group_id = $1 AND status = 'active')
       WHERE ps.group_id = $1 AND ps.cycle_number = $3 AND ps.status = 'scheduled'`,
      [groupId, g.monthly_amount, cycle]
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
      `SELECT c.*, g.id AS group_id, g.name AS group_name,
              g.grace_period_days, g.late_fee_type, g.late_fee_value, g.monthly_amount
       FROM contributions c JOIN groups g ON g.id = c.group_id
       WHERE c.id = $1 AND c.user_id = $2
       FOR UPDATE`,
      [contributionId, payerUserId]
    );
    if (!contribResult.rows.length) throw Object.assign(new Error('Contribution not found'), { status: 404 });

    const contrib = contribResult.rows[0];
    if (contrib.status === 'paid') throw Object.assign(new Error('Already paid'), { status: 409 });

    // Late assessment uses the group's grace period: only late once the due
    // date PLUS the grace window has passed. The group's own late fee (fixed
    // or percentage of the monthly amount) is recorded separately from any
    // platform fee below.
    const graceDays = contrib.grace_period_days ?? 0;
    const graceCutoff = new Date(contrib.due_date);
    graceCutoff.setDate(graceCutoff.getDate() + Number(graceDays));
    const isLate = new Date() > graceCutoff;
    let groupLateFee = 0;
    if (isLate && contrib.late_fee_type === 'fixed') {
      groupLateFee = Number(contrib.late_fee_value) || 0;
    } else if (isLate && contrib.late_fee_type === 'percentage') {
      groupLateFee = Number(contrib.monthly_amount) * (Number(contrib.late_fee_value) / 100);
    }

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
       VALUES ($1, 'contribution', 'credit', $2, $3, $3::numeric + $2::numeric, 'completed', $4, 'contribution', $5)`,
      [wallet.id, netAmount, wallet.balance, contrib.id, `Contribution - Cycle ${contrib.cycle_number} Rd ${contrib.round_number}`]
    );

    // Fee transaction
    if (feeAmount > 0) {
      await client.query(
        `INSERT INTO transactions (wallet_id, type, direction, amount, balance_before, balance_after,
           status, reference_id, reference_type, description)
         VALUES ($1, 'fee', 'debit', $2, $3, $3::numeric - $2::numeric, 'completed', $4, 'contribution', 'Platform fee')`,
        [wallet.id, feeAmount, wallet.balance + netAmount, contrib.id]
      );
    }

    // Mark contribution paid (isLate + groupLateFee computed above from the
    // group's grace period and late-fee rule)
    await client.query(
      `UPDATE contributions
       SET status = $1, amount_paid = amount_due, paid_at = NOW(), late_fee_charged = $2
       WHERE id = $3`,
      [isLate ? 'late' : 'paid', groupLateFee, contributionId]
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

    return { contribution: contrib, feeCharged: feeAmount, lateFee: groupLateFee, isLate, netAmount };
  });
};

// Majority-vote size for n members (2→2, 3→2, 4→3, 5→3, 6→4 ...).
const majorityOf = (n) => Math.max(1, Math.ceil((Number(n) + 1) / 2));

/**
 * Disburse the scheduled payout for the current round to the recipient.
 * Enforces the group constitution: the contribution threshold must be met,
 * and — unless the caller overrides (platform admin manual review) — the
 * payout must have the required approvals when the group uses majority voting.
 * The first successful payout locks the schedule and membership.
 */
const disbursePayout = async (payoutScheduleId, adminUserId, options = {}) => {
  const { skipApprovalCheck = false } = options;
  return withTransaction(async (client) => {
    const schedResult = await client.query(
      `SELECT ps.*, g.monthly_amount, g.max_members, g.name AS group_name,
              g.contribution_threshold_percent, g.payout_approval_mode,
              g.payout_approvals_required, g.current_cycle,
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

    // Active member count for this group (drives expected pool + auto majority)
    const memberCountRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = $1 AND status = 'active'`,
      [sched.group_id]
    );
    const activeMembers = memberCountRes.rows[0].n || 0;

    // ── Rule 1: contribution threshold before payout ──
    const thresholdPercent = sched.contribution_threshold_percent ?? 100;
    const collectedRes = await client.query(
      `SELECT COALESCE(SUM(amount_paid), 0)::float8 AS collected
       FROM contributions
       WHERE group_id = $1 AND cycle_number = $2 AND status IN ('paid', 'late')`,
      [sched.group_id, sched.cycle_number]
    );
    const collected = Number(collectedRes.rows[0].collected);
    const expectedPool = Number(sched.monthly_amount) * activeMembers;
    const requiredCollected = expectedPool * (thresholdPercent / 100);
    if (expectedPool > 0 && collected + 0.001 < requiredCollected) {
      throw Object.assign(new Error(
        `Contribution threshold not met: ${thresholdPercent}% required ` +
        `(${sched.monthly_amount} × ${activeMembers} = ${expectedPool.toFixed(2)} expected, ` +
        `need ${requiredCollected.toFixed(2)}, collected ${collected.toFixed(2)}).`
      ), { status: 409 });
    }

    // ── Rule 2: payout approval (majority vote) ──
    if (!skipApprovalCheck && sched.payout_approval_mode === 'majority') {
      const required = sched.payout_approvals_required > 0
        ? sched.payout_approvals_required
        : majorityOf(activeMembers);
      const approvalsRes = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE action = 'approved')::int AS approved,
           COUNT(*) FILTER (WHERE action = 'rejected')::int AS rejected
         FROM payout_approvals WHERE payout_schedule_id = $1`,
        [payoutScheduleId]
      );
      const approved = approvalsRes.rows[0].approved || 0;
      if (approved < required) {
        throw Object.assign(new Error(
          `Payout needs ${required} approval${required !== 1 ? 's' : ''} before it can be disbursed (has ${approved}).`
        ), { status: 409 });
      }
    }

    // Get recipient personal wallet
    const walletResult = await client.query(
      `INSERT INTO wallets (owner_id, type, currency)
       VALUES ($1, 'personal', 'ZMW')
       ON CONFLICT (owner_id, type, group_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [sched.user_id]
    );
    const wallet = walletResult.rows[0];

    // The pot actually paid out is what the group collected this cycle (not the
    // stale expected_amount). Falls back to expected_amount if nothing recorded.
    const grossPayout = collected > 0 ? collected : Number(sched.expected_amount);

    // Fee on payout
    const feeResult = await client.query(
      `SELECT * FROM fees_config WHERE applies_to = 'payout' AND is_active = TRUE LIMIT 1`
    );
    const feeConfig = feeResult.rows[0];
    const feeAmount = feeConfig
      ? feeConfig.fee_type === 'percentage'
        ? grossPayout * (Number(feeConfig.value) / 100)
        : Number(feeConfig.value)
      : 0;

    const netPayout = grossPayout - feeAmount;

    // Credit personal wallet
    await client.query(
      'UPDATE wallets SET balance = balance + $1 WHERE id = $2',
      [netPayout, wallet.id]
    );

    // Transaction
    await client.query(
      `INSERT INTO transactions (wallet_id, type, direction, amount, balance_before, balance_after,
         status, reference_id, reference_type, description)
       VALUES ($1, 'payout', 'credit', $2, $3, $3::numeric + $2::numeric, 'completed', $4, 'payout_schedule', $5)`,
      [wallet.id, netPayout, wallet.balance, sched.id, `Chilimba payout – ${sched.group_name} Cycle ${sched.cycle_number}`]
    );

    // Update schedule
    await client.query(
      `UPDATE payout_schedule
       SET status = 'completed', actual_amount = $1, paid_at = NOW()
       WHERE id = $2`,
      [netPayout, payoutScheduleId]
    );

    // First payout locks the payout schedule and membership (constitution rule)
    await client.query(
      `UPDATE groups SET schedule_locked = TRUE, members_locked = TRUE, updated_at = NOW()
       WHERE id = $1 AND (schedule_locked = FALSE OR members_locked = FALSE)`,
      [sched.group_id]
    );

    // Audit
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, changes)
       VALUES ($1, 'payout_disbursed', 'payout_schedule', $2, $3)`,
      [adminUserId, payoutScheduleId, JSON.stringify({
        recipientId: sched.user_id, amount: netPayout, cycle: sched.cycle_number,
      })]
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

module.exports = { generatePayoutSchedule, generateContributionRound, enrollMemberInCycle, recordContribution, disbursePayout };
