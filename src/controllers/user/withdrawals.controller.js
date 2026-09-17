const { query, withTransaction } = require('../../config/db');
const { notify } = require('../../services/notification.service');
const email = require('../../services/email.service');
const { getEffectivePermissions, hasPermission, membersWithPermission } = require('../../services/permissions.service');

const INACTIVE_MSG = (name) =>
  `${name} hasn't been activated yet. Withdrawals open once the group admin activates it.`;

// POST /api/groups/:groupId/withdrawals
const createWithdrawalRequest = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { amount, reason } = req.body;

    const group = await query(
      'SELECT min_approvals_withdrawal, name, status FROM groups WHERE id = $1',
      [groupId]
    );
    if (!group.rows.length) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }
    if (group.rows[0].status === 'inactive') {
      return res.status(409).json({ success: false, message: INACTIVE_MSG(group.rows[0].name) });
    }

    const approvalsNeeded = group.rows[0].min_approvals_withdrawal;

    // Only approvers vote now, so a request nobody can carry must not be
    // created — it would sit pending until it expired.
    const voters = await membersWithPermission(groupId, 'withdrawal.vote', req.user.id);
    if (voters.length < approvalsNeeded) {
      return res.status(400).json({
        success: false,
        message: `This request needs ${approvalsNeeded} approval${approvalsNeeded !== 1 ? 's' : ''} but only `
          + `${voters.length} approver${voters.length !== 1 ? 's' : ''} can vote on it. `
          + 'Ask the group admin to add approvers before requesting a withdrawal.',
      });
    }
    const expiryHours = parseInt(process.env.WITHDRAWAL_EXPIRY_HOURS) || 72;
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    const result = await query(
      `INSERT INTO withdrawal_requests
         (group_id, requested_by, amount, reason, approvals_needed, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [groupId, req.user.id, amount, reason, approvalsNeeded, expiresAt]
    );

    const withdrawal = result.rows[0];
    // "Your approval is needed" goes to the people who can actually give it.
    await Promise.all(voters.map(uid => notify(
      uid, 'withdrawal_initiated',
      `${group.rows[0].name} – Withdrawal Request`,
      `A withdrawal of ZMW ${amount} has been requested. Your approval is needed.`,
      { withdrawalId: withdrawal.id, amount }
    ).catch(() => {})));

    res.status(201).json({ success: true, data: withdrawal });

    query(
      `SELECT email, first_name, last_name FROM users WHERE id = ANY($1::uuid[])`,
      [voters]
    ).then(({ rows }) => {
      for (const member of rows) {
        email.sendWithdrawalRequested(member.email, member.first_name, req.user, withdrawal, group.rows[0]);
      }
    }).catch(() => {});
  } catch (err) { next(err); }
};

// GET /api/groups/:groupId/withdrawals
const getGroupWithdrawals = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const result = await query(
      `SELECT wr.id,
              wr.group_id       AS "groupId",
              wr.requested_by   AS "requestedBy",
              wr.amount,
              wr.reason,
              wr.status,
              wr.approvals_needed AS "approvalsNeeded",
              wr.approvals_count  AS "approvalsCount",
              wr.created_at       AS "createdAt",
              u.first_name || ' ' || u.last_name AS "requesterName",
              COALESCE(
                json_agg(
                  json_build_object(
                    'memberId', wa.member_id,
                    'action', wa.action,
                    'comment', wa.comment,
                    'votedAt', wa.voted_at
                  )
                ) FILTER (WHERE wa.id IS NOT NULL), '[]'
              ) AS votes
       FROM withdrawal_requests wr
       JOIN users u ON u.id = wr.requested_by
       LEFT JOIN withdrawal_approvals wa ON wa.withdrawal_id = wr.id
       WHERE wr.group_id = $1
       GROUP BY wr.id, u.first_name, u.last_name
       ORDER BY wr.created_at DESC`,
      [groupId]
    );
    const rows = result.rows;
    const [groupRes, myPerms] = await Promise.all([
      query('SELECT status FROM groups WHERE id = $1', [groupId]),
      getEffectivePermissions(req.user.id, groupId),
    ]);
    const groupStatus = groupRes.rows[0]?.status ?? null;
    res.json({
      success: true,
      data: rows,
      pagination: { total: rows.length, totalPages: 1, page: 1, limit: rows.length },
      meta: {
        groupStatus,
        canRequest: groupStatus !== 'inactive',
        canVote: groupStatus !== 'inactive' && hasPermission(myPerms, 'withdrawal.vote'),
      },
    });
  } catch (err) { next(err); }
};

// POST /api/withdrawals/:withdrawalId/vote
const voteOnWithdrawal = async (req, res, next) => {
  try {
    const { withdrawalId } = req.params;
    const { action, comment } = req.body; // 'approved' | 'rejected'

    if (!['approved', 'rejected'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be approved or rejected' });
    }

    let outcomeData = null;

    await withTransaction(async (client) => {
      const wrResult = await client.query(
        `SELECT wr.*, g.name AS group_name, g.min_approvals_withdrawal, g.status AS group_status
         FROM withdrawal_requests wr JOIN groups g ON g.id = wr.group_id
         WHERE wr.id = $1 AND wr.status = 'pending_approval' AND wr.expires_at > NOW()
         FOR UPDATE`,
        [withdrawalId]
      );
      if (!wrResult.rows.length) throw Object.assign(new Error('Withdrawal not found or expired'), { status: 404 });

      const wr = wrResult.rows[0];
      if (wr.group_status === 'inactive') {
        throw Object.assign(new Error(INACTIVE_MSG(wr.group_name)), { status: 409 });
      }

      // Check voter is a member of the group
      const memberCheck = await client.query(
        `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
        [wr.group_id, req.user.id]
      );
      if (!memberCheck.rows.length) throw Object.assign(new Error('Not a group member'), { status: 403 });

      // Only the group's approvers carry a withdrawal vote (migration 018).
      const myPerms = await getEffectivePermissions(req.user.id, wr.group_id);
      if (!hasPermission(myPerms, 'withdrawal.vote')) {
        throw Object.assign(new Error('Only group approvers can vote on withdrawal requests.'), { status: 403 });
      }

      // Prevent requester from approving their own
      if (wr.requested_by === req.user.id) {
        throw Object.assign(new Error('Cannot vote on your own withdrawal request'), { status: 400 });
      }

      // Record vote
      await client.query(
        `INSERT INTO withdrawal_approvals (withdrawal_id, member_id, action, comment)
         VALUES ($1, $2, $3, $4)`,
        [withdrawalId, req.user.id, action, comment]
      );

      // Update counts
      const field = action === 'approved' ? 'approvals_count' : 'rejections_count';
      const updated = await client.query(
        `UPDATE withdrawal_requests SET ${field} = ${field} + 1 WHERE id = $1 RETURNING *`,
        [withdrawalId]
      );
      const updatedWr = updated.rows[0];

      let newStatus = null;
      if (updatedWr.approvals_count >= wr.approvals_needed) {
        newStatus = 'approved';
      } else if (updatedWr.rejections_count > (wr.approvals_needed)) {
        newStatus = 'rejected';
      }

      if (newStatus) {
        await client.query(
          `UPDATE withdrawal_requests SET status = $1, processed_at = NOW() WHERE id = $2`,
          [newStatus, withdrawalId]
        );
        const notifType = newStatus === 'approved' ? 'withdrawal_approved' : 'withdrawal_rejected';
        await notify(
          wr.requested_by,
          notifType,
          `Withdrawal ${newStatus === 'approved' ? 'Approved ✅' : 'Rejected ❌'}`,
          `Your withdrawal request of ZMW ${wr.amount} has been ${newStatus}.`,
          { withdrawalId }
        );
        outcomeData = { requestedBy: wr.requested_by, withdrawal: updatedWr, status: newStatus, groupName: wr.group_name };
      }
    });

    if (outcomeData) {
      query('SELECT first_name, last_name, email FROM users WHERE id = $1', [outcomeData.requestedBy])
        .then(({ rows }) => {
          if (rows.length) {
            email.sendWithdrawalOutcome(
              rows[0],
              outcomeData.withdrawal,
              outcomeData.status,
              { name: outcomeData.groupName, id: outcomeData.withdrawal.group_id }
            );
          }
        }).catch(() => {});
    }

    res.json({ success: true, message: 'Vote recorded' });
  } catch (err) { next(err); }
};

module.exports = { createWithdrawalRequest, getGroupWithdrawals, voteOnWithdrawal };
