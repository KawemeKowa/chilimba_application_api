const crypto = require('crypto');
const { query, withTransaction } = require('../../config/db');
const { disbursePayout } = require('../../services/chilimba.service');
const { notify, notifyGroup } = require('../../services/notification.service');
const lipila = require('../../services/lipila.service');
const email  = require('../../services/email.service');
const logger = require('../../config/logger');

const { getEffectivePermissions, hasPermission } = require('../../services/permissions.service');

// Members of a group who hold a given permission (via system role, legacy
// permissions array, or custom role assignment), excluding one user.
const otherMembersWithPermission = async (groupId, permission, excludeUserId) => {
  const r = await query(
    `SELECT gm.user_id FROM group_members gm
     WHERE gm.group_id = $1 AND gm.status = 'active' AND gm.user_id != $2
       AND EXISTS (
         SELECT 1 FROM roles ro JOIN role_permissions rp ON rp.role_id = ro.id
         WHERE rp.permission IN ($3, '*')
           AND (
             (ro.scope = 'group' AND ro.name = gm.role)
             OR (ro.scope = 'group' AND ro.name = ANY(gm.permissions))
             OR ro.id IN (
               SELECT ur.role_id FROM user_roles ur
               WHERE ur.user_id = gm.user_id
                 AND (ur.group_id IS NULL OR ur.group_id = gm.group_id)
             )
           )
       )`,
    [groupId, excludeUserId, permission]
  );
  return r.rows.map(row => row.user_id);
};

// ─── GET /api/groups/:groupId/payout-order ────────────────────────────────────
// Current order, members due for payout, and any pending proposal
const getPayoutOrder = async (req, res, next) => {
  try {
    const { groupId } = req.params;

    const [membersRes, dueRes, proposalRes] = await Promise.all([
      query(
        `SELECT gm.user_id   AS "userId",
                gm.payout_order AS "payoutOrder",
                gm.permissions,
                gm.role,
                u.first_name AS "firstName", u.last_name AS "lastName"
         FROM group_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1 AND gm.status = 'active'
         ORDER BY gm.payout_order ASC NULLS LAST, u.first_name ASC`,
        [groupId]
      ),
      query(
        `SELECT ps.id, ps.user_id AS "userId", ps.cycle_number AS "cycleNumber",
                ps.payout_order AS "payoutOrder", ps.scheduled_date AS "scheduledDate",
                ps.expected_amount AS "expectedAmount", ps.status,
                u.first_name AS "firstName", u.last_name AS "lastName"
         FROM payout_schedule ps JOIN users u ON u.id = ps.user_id
         WHERE ps.group_id = $1 AND ps.status = 'scheduled'
         ORDER BY ps.payout_order ASC`,
        [groupId]
      ),
      query(
        `SELECT p.id, p.proposed_by AS "proposedBy", p.new_order AS "newOrder",
                p.status, p.approvals_needed AS "approvalsNeeded",
                p.approvals_count AS "approvalsCount", p.created_at AS "createdAt",
                u.first_name || ' ' || u.last_name AS "proposerName",
                COALESCE(
                  json_agg(json_build_object('approverId', pa.approver_id, 'action', pa.action))
                  FILTER (WHERE pa.id IS NOT NULL), '[]'
                ) AS votes
         FROM payout_order_proposals p
         JOIN users u ON u.id = p.proposed_by
         LEFT JOIN payout_order_approvals pa ON pa.proposal_id = p.id
         WHERE p.group_id = $1 AND p.status = 'pending'
         GROUP BY p.id, u.first_name, u.last_name
         ORDER BY p.created_at DESC LIMIT 1`,
        [groupId]
      ),
    ]);

    const myPerms = await getEffectivePermissions(req.user.id, groupId);

    res.json({
      success: true,
      data: {
        members: membersRes.rows,
        duePayouts: dueRes.rows,
        pendingProposal: proposalRes.rows[0] || null,
        myPermissions: myPerms,
        myRole: req.groupMembership.role,
      },
    });
  } catch (err) { next(err); }
};

// Apply an order (array of {userId, payoutOrder}) inside a transaction
const applyOrder = async (client, groupId, newOrder) => {
  for (const item of newOrder) {
    await client.query(
      `UPDATE group_members SET payout_order = $1
       WHERE group_id = $2 AND user_id = $3 AND status = 'active'`,
      [item.payoutOrder, groupId, item.userId]
    );
  }
};

// ─── POST /api/groups/:groupId/payout-order ───────────────────────────────────
// Propose a new order. Sole approver → applied immediately.
// Multiple approvers → all other approvers must approve.
// Body: { newOrder: [{userId, payoutOrder}] }  or  { alphabetical: true }
const proposePayoutOrder = async (req, res, next) => {
  try {
    const { groupId } = req.params;

    const myPerms = await getEffectivePermissions(req.user.id, groupId);
    if (!hasPermission(myPerms, 'payout.set_order')) {
      return res.status(403).json({ success: false, message: 'You do not have permission to change the payout order.' });
    }

    let { newOrder } = req.body;

    // Alphabetical shortcut — server builds the order
    if (req.body.alphabetical) {
      const r = await query(
        `SELECT gm.user_id FROM group_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1 AND gm.status = 'active'
         ORDER BY u.first_name ASC, u.last_name ASC`,
        [groupId]
      );
      newOrder = r.rows.map((row, i) => ({ userId: row.user_id, payoutOrder: i + 1 }));
    }

    if (!Array.isArray(newOrder) || !newOrder.length) {
      return res.status(400).json({ success: false, message: 'newOrder array is required (or pass alphabetical: true).' });
    }

    // Validate all entries are active members of the group
    const memberCheck = await query(
      `SELECT user_id FROM group_members WHERE group_id = $1 AND status = 'active'`,
      [groupId]
    );
    const activeIds = new Set(memberCheck.rows.map(r => r.user_id));
    if (!newOrder.every(o => activeIds.has(o.userId))) {
      return res.status(400).json({ success: false, message: 'newOrder contains users who are not active members of this group.' });
    }

    const otherApprovers = await otherMembersWithPermission(groupId, 'payout.approve_order', req.user.id);
    const othersCount = otherApprovers.length;

    // Sole approver — apply immediately
    if (othersCount === 0) {
      await withTransaction(async (client) => {
        await applyOrder(client, groupId, newOrder);
      });
      notifyGroup(groupId, 'group', 'Payout Order Updated',
        'The payout order for your group has been updated.', {}, req.user.id).catch(() => {});
      return res.json({ success: true, message: 'Payout order updated.', data: { applied: true } });
    }

    // Multiple approvers — create a proposal, replacing any pending one
    await query(
      `UPDATE payout_order_proposals SET status = 'rejected', resolved_at = NOW()
       WHERE group_id = $1 AND status = 'pending'`,
      [groupId]
    );
    const result = await query(
      `INSERT INTO payout_order_proposals (group_id, proposed_by, new_order, approvals_needed)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [groupId, req.user.id, JSON.stringify(newOrder), othersCount]
    );

    // Notify the other approvers
    for (const approverId of otherApprovers) {
      notify(approverId, 'group', 'Payout Order Change Requested',
        'A change to your group\'s payout order needs your approval.',
        { groupId, proposalId: result.rows[0].id }).catch(() => {});
    }

    res.status(201).json({
      success: true,
      message: `Proposal created. ${othersCount} approver${othersCount !== 1 ? 's' : ''} must approve before it takes effect.`,
      data: { applied: false, proposalId: result.rows[0].id, approvalsNeeded: othersCount },
    });
  } catch (err) { next(err); }
};

// ─── POST /api/groups/:groupId/payout-order/:proposalId/vote ──────────────────
// Body: { action: 'approved' | 'rejected' }
const voteOnProposal = async (req, res, next) => {
  try {
    const { groupId, proposalId } = req.params;
    const { action } = req.body;

    const myPerms = await getEffectivePermissions(req.user.id, groupId);
    if (!hasPermission(myPerms, 'payout.approve_order')) {
      return res.status(403).json({ success: false, message: 'You do not have permission to vote on payout order changes.' });
    }
    if (!['approved', 'rejected'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be approved or rejected.' });
    }

    let outcome = null;

    await withTransaction(async (client) => {
      const pRes = await client.query(
        `SELECT * FROM payout_order_proposals
         WHERE id = $1 AND group_id = $2 AND status = 'pending' FOR UPDATE`,
        [proposalId, groupId]
      );
      if (!pRes.rows.length) throw Object.assign(new Error('Proposal not found or already resolved.'), { status: 404 });
      const proposal = pRes.rows[0];

      if (proposal.proposed_by === req.user.id) {
        throw Object.assign(new Error('You cannot vote on your own proposal.'), { status: 400 });
      }

      await client.query(
        `INSERT INTO payout_order_approvals (proposal_id, approver_id, action) VALUES ($1, $2, $3)`,
        [proposalId, req.user.id, action]
      );

      if (action === 'rejected') {
        await client.query(
          `UPDATE payout_order_proposals SET status = 'rejected', resolved_at = NOW() WHERE id = $1`,
          [proposalId]
        );
        outcome = { status: 'rejected', proposedBy: proposal.proposed_by };
        return;
      }

      const updated = await client.query(
        `UPDATE payout_order_proposals SET approvals_count = approvals_count + 1
         WHERE id = $1 RETURNING approvals_count, approvals_needed, new_order`,
        [proposalId]
      );
      const p = updated.rows[0];

      if (p.approvals_count >= p.approvals_needed) {
        await applyOrder(client, groupId, p.new_order);
        await client.query(
          `UPDATE payout_order_proposals SET status = 'approved', resolved_at = NOW() WHERE id = $1`,
          [proposalId]
        );
        outcome = { status: 'approved', proposedBy: proposal.proposed_by };
      }
    });

    if (outcome) {
      const approved = outcome.status === 'approved';
      notify(outcome.proposedBy, 'group',
        `Payout Order Change ${approved ? 'Approved ✅' : 'Rejected ❌'}`,
        approved
          ? 'Your payout order change has been approved by all approvers and is now active.'
          : 'Your payout order change was rejected.',
        { groupId }).catch(() => {});
      if (approved) {
        notifyGroup(groupId, 'group', 'Payout Order Updated',
          'The payout order for your group has been updated.', {}, null).catch(() => {});
      }
    }

    res.json({ success: true, message: outcome ? `Proposal ${outcome.status}.` : 'Vote recorded.' });
  } catch (err) { next(err); }
};

// ─── POST /api/groups/:groupId/members/:userId/permissions ────────────────────
// Grant or revoke a permission (group admins only). Body: { permission: 'approver', grant: true|false }
const setMemberPermission = async (req, res, next) => {
  try {
    const { groupId, userId } = req.params;
    const { permission, grant } = req.body;

    if (permission !== 'approver') {
      return res.status(400).json({ success: false, message: 'Unknown permission.' });
    }

    // Owners always keep approver
    const target = await query(
      `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
      [groupId, userId]
    );
    if (!target.rows.length) {
      return res.status(404).json({ success: false, message: 'Member not found in this group.' });
    }
    if (target.rows[0].role === 'owner' && grant === false) {
      return res.status(400).json({ success: false, message: 'The group creator\'s approver permission cannot be revoked.' });
    }

    if (grant) {
      await query(
        `UPDATE group_members SET permissions = array_append(permissions, 'approver')
         WHERE group_id = $1 AND user_id = $2 AND NOT ('approver' = ANY(permissions))`,
        [groupId, userId]
      );
    } else {
      await query(
        `UPDATE group_members SET permissions = array_remove(permissions, 'approver')
         WHERE group_id = $1 AND user_id = $2`,
        [groupId, userId]
      );
    }

    notify(userId, 'group',
      grant ? 'Approver Permission Granted' : 'Approver Permission Revoked',
      grant
        ? 'You can now approve payout order changes and trigger disbursements in your group.'
        : 'Your approver permission has been removed.',
      { groupId }).catch(() => {});

    res.json({ success: true, message: `Approver permission ${grant ? 'granted' : 'revoked'}.` });
  } catch (err) { next(err); }
};

// ─── POST /api/groups/:groupId/payouts/:payoutScheduleId/disburse ─────────────
// Approver triggers disbursement for the member who is next in line
const disburseGroupPayout = async (req, res, next) => {
  try {
    const { groupId, payoutScheduleId } = req.params;

    const myPerms = await getEffectivePermissions(req.user.id, groupId);
    if (!hasPermission(myPerms, 'payout.disburse')) {
      return res.status(403).json({ success: false, message: 'You do not have permission to trigger disbursements.' });
    }

    // Must be the next scheduled payout for this group
    const nextRes = await query(
      `SELECT id FROM payout_schedule
       WHERE group_id = $1 AND status = 'scheduled'
       ORDER BY payout_order ASC LIMIT 1`,
      [groupId]
    );
    if (!nextRes.rows.length) {
      return res.status(404).json({ success: false, message: 'No scheduled payouts for this group.' });
    }
    if (nextRes.rows[0].id !== payoutScheduleId) {
      return res.status(400).json({ success: false, message: 'Only the next member in the payout order can be disbursed.' });
    }

    const result = await disbursePayout(payoutScheduleId, req.user.id);
    res.json({
      success: true,
      message: 'Payout disbursed',
      data: { netPayout: result.netPayout, feeCharged: result.feeCharged },
    });

    // Fire-and-forget: email + Lipila MoMo leg (mirrors admin flow)
    query(
      `SELECT u.first_name, u.last_name, u.email,
              pm.mobile_number, pm.mobile_provider
       FROM users u
       LEFT JOIN user_payment_methods pm ON pm.user_id = u.id AND pm.type = 'mobile_money'
       WHERE u.id = $1`,
      [result.payout.user_id]
    ).then(({ rows }) => {
      if (!rows.length) return;
      const user = rows[0];

      if (user.mobile_number) {
        const referenceId = crypto.randomUUID();
        email.sendPayoutDisbursed(user, result.payout, { name: result.payout.group_name, id: groupId }, referenceId).catch(() => {});
        lipila.initiateDisbursement({
          referenceId,
          amount: result.netPayout,
          phone: user.mobile_number,
          narration: `Chilimba payout – ${result.payout.group_name}`,
        }).then(lipilaRes => {
          query(
            `SELECT id FROM wallets WHERE owner_id = $1 AND type = 'personal' AND group_id IS NULL LIMIT 1`,
            [result.payout.user_id]
          ).then(({ rows: wRows }) => {
            query(
              `INSERT INTO lipila_transactions
                 (reference_id, lipila_id, type, status, amount, account_number, narration, wallet_id, user_id, group_id)
               VALUES ($1,$2,'disbursement','pending',$3,$4,$5,$6,$7,$8)`,
              [referenceId, lipilaRes.identifier || null, result.netPayout,
               user.mobile_number, `Chilimba payout – ${result.payout.group_name}`,
               wRows[0]?.id || null, result.payout.user_id, groupId]
            ).catch(e => logger.error(`[lipila] failed to record disbursement txn: ${e.message}`));
          }).catch(() => {});
        }).catch(e => logger.error(`[lipila] disbursement failed: ${e.message}`));
      } else {
        email.sendPayoutDisbursed(user, result.payout, { name: result.payout.group_name, id: groupId }).catch(() => {});
        logger.warn(`[lipila] user ${result.payout.user_id} has no mobile_money payment method — wallet credited only`);
      }
    }).catch(() => {});
  } catch (err) { next(err); }
};

module.exports = {
  getPayoutOrder,
  proposePayoutOrder,
  voteOnProposal,
  setMemberPermission,
  disburseGroupPayout,
};
