const { query, withTransaction } = require('../../config/db');
const { notifyGroup, notify } = require('../../services/notification.service');

// POST /api/groups/:groupId/withdrawals
const createWithdrawalRequest = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { amount, reason } = req.body;

    const group = await query(
      'SELECT min_approvals_withdrawal, name FROM groups WHERE id = $1',
      [groupId]
    );
    if (!group.rows.length) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    const approvalsNeeded = group.rows[0].min_approvals_withdrawal;
    const expiryHours = parseInt(process.env.WITHDRAWAL_EXPIRY_HOURS) || 72;
    const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    const result = await query(
      `INSERT INTO withdrawal_requests
         (group_id, requested_by, amount, reason, approvals_needed, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [groupId, req.user.id, amount, reason, approvalsNeeded, expiresAt]
    );

    const withdrawal = result.rows[0];
    await notifyGroup(
      groupId, 'withdrawal_initiated',
      `${group.rows[0].name} – Withdrawal Request`,
      `A withdrawal of ZMW ${amount} has been requested. Your approval is needed.`,
      { withdrawalId: withdrawal.id, amount },
      req.user.id
    );

    res.status(201).json({ success: true, data: withdrawal });
  } catch (err) { next(err); }
};

// GET /api/groups/:groupId/withdrawals
const getGroupWithdrawals = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const result = await query(
      `SELECT wr.*,
              u.first_name || ' ' || u.last_name AS requested_by_name,
              COALESCE(
                json_agg(
                  json_build_object(
                    'memberId', wa.member_id,
                    'action', wa.action,
                    'comment', wa.comment,
                    'votedAt', wa.voted_at
                  )
                ) FILTER (WHERE wa.id IS NOT NULL), '[]'
              ) AS approvals
       FROM withdrawal_requests wr
       JOIN users u ON u.id = wr.requested_by
       LEFT JOIN withdrawal_approvals wa ON wa.withdrawal_id = wr.id
       WHERE wr.group_id = $1
       GROUP BY wr.id, u.first_name, u.last_name
       ORDER BY wr.created_at DESC`,
      [groupId]
    );
    res.json({ success: true, data: result.rows });
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

    await withTransaction(async (client) => {
      const wrResult = await client.query(
        `SELECT wr.*, g.name AS group_name, g.min_approvals_withdrawal
         FROM withdrawal_requests wr JOIN groups g ON g.id = wr.group_id
         WHERE wr.id = $1 AND wr.status = 'pending_approval' AND wr.expires_at > NOW()
         FOR UPDATE`,
        [withdrawalId]
      );
      if (!wrResult.rows.length) throw Object.assign(new Error('Withdrawal not found or expired'), { status: 404 });

      const wr = wrResult.rows[0];

      // Check voter is a member of the group
      const memberCheck = await client.query(
        `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
        [wr.group_id, req.user.id]
      );
      if (!memberCheck.rows.length) throw Object.assign(new Error('Not a group member'), { status: 403 });

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
      if (updatedWr.approvals_count >= wr.g_min_approvals_withdrawal || updatedWr.approvals_count >= wr.approvals_needed) {
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
      }
    });

    res.json({ success: true, message: 'Vote recorded' });
  } catch (err) { next(err); }
};

module.exports = { createWithdrawalRequest, getGroupWithdrawals, voteOnWithdrawal };
