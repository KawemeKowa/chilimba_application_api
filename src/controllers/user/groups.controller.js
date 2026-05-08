const { query, withTransaction } = require('../../config/db');
const { generatePayoutSchedule, generateContributionRound } = require('../../services/chilimba.service');
const { notify, notifyGroup } = require('../../services/notification.service');
const { paginate, paginatedResponse } = require('../../middleware/errorHandler');
const slugify = require('slugify');
const crypto = require('crypto');

// Generate unique invite code
const makeInviteCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

// POST /api/groups
const createGroup = async (req, res, next) => {
  try {
    const {
      name, description, monthlyAmount, maxMembers = 12,
      contributionDay = 1, payoutDay = 25, minApprovalsWithdrawal = 2,
      allowLateContributions = true, lateFeeAmount = 0, currency = 'ZMW'
    } = req.body;

    const slug = slugify(`${name}-${Date.now()}`, { lower: true, strict: true });
    const inviteCode = makeInviteCode();

    const result = await withTransaction(async (client) => {
      const groupResult = await client.query(
        `INSERT INTO groups
           (name, description, slug, monthly_amount, currency, max_members,
            contribution_day, payout_day, min_approvals_withdrawal,
            allow_late_contributions, late_fee_amount, invite_code, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [name, description, slug, monthlyAmount, currency, maxMembers,
         contributionDay, payoutDay, minApprovalsWithdrawal,
         allowLateContributions, lateFeeAmount, inviteCode, req.user.id]
      );
      const group = groupResult.rows[0];

      // Add creator as owner
      await client.query(
        `INSERT INTO group_members (group_id, user_id, role, status, payout_order, joined_at)
         VALUES ($1, $2, 'owner', 'active', 1, NOW())`,
        [group.id, req.user.id]
      );

      // Generate contributions and payout schedule for cycle 1 / round 1
      await generatePayoutSchedule(client, group.id, 1, payoutDay);
      await generateContributionRound(client, group.id, 1, 1, contributionDay);

      return group;
    });

    res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
};

// POST /api/groups/join
const joinGroup = async (req, res, next) => {
  try {
    const { inviteCode } = req.body;

    const groupResult = await query(
      `SELECT * FROM groups WHERE invite_code = $1 AND status = 'active'`,
      [inviteCode.toUpperCase()]
    );
    if (!groupResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Invalid or expired invite code' });
    }
    const group = groupResult.rows[0];

    // Check member count
    const countResult = await query(
      `SELECT COUNT(*) FROM group_members WHERE group_id = $1 AND status = 'active'`,
      [group.id]
    );
    if (parseInt(countResult.rows[0].count) >= group.max_members) {
      return res.status(409).json({ success: false, message: 'Group is full' });
    }

    // Check already a member
    const existingResult = await query(
      `SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [group.id, req.user.id]
    );
    if (existingResult.rows.length) {
      return res.status(409).json({ success: false, message: 'Already in this group' });
    }

    // Assign next payout order
    const orderResult = await query(
      `SELECT COALESCE(MAX(payout_order), 0) + 1 AS next_order
       FROM group_members WHERE group_id = $1`,
      [group.id]
    );
    const nextOrder = orderResult.rows[0].next_order;

    await query(
      `INSERT INTO group_members (group_id, user_id, role, status, payout_order, joined_at)
       VALUES ($1, $2, 'member', 'active', $3, NOW())`,
      [group.id, req.user.id, nextOrder]
    );

    await notifyGroup(
      group.id, 'group_joined',
      `${group.name} – New Member`,
      `A new member has joined the group.`,
      {}, req.user.id
    );

    res.json({ success: true, message: 'Joined group successfully', data: { groupId: group.id } });
  } catch (err) { next(err); }
};

// GET /api/groups  (my groups)
const getMyGroups = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT g.*, gm.role AS my_role, gm.payout_order,
              COUNT(DISTINCT gm2.user_id) FILTER (WHERE gm2.status = 'active') AS active_members
       FROM groups g
       JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1 AND gm.status = 'active'
       JOIN group_members gm2 ON gm2.group_id = g.id
       GROUP BY g.id, gm.role, gm.payout_order
       ORDER BY g.created_at DESC`,
      [req.user.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// GET /api/groups/:groupId
const getGroupDetail = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const groupResult = await query(
      `SELECT g.*,
              COUNT(DISTINCT gm.user_id) FILTER (WHERE gm.status = 'active') AS active_members
       FROM groups g
       LEFT JOIN group_members gm ON gm.group_id = g.id
       WHERE g.id = $1
       GROUP BY g.id`,
      [groupId]
    );
    if (!groupResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    const membersResult = await query(
      `SELECT gm.*, u.first_name, u.last_name, u.email, u.profile_photo_url
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 AND gm.status = 'active'
       ORDER BY gm.payout_order ASC`,
      [groupId]
    );

    res.json({
      success: true,
      data: { ...groupResult.rows[0], members: membersResult.rows }
    });
  } catch (err) { next(err); }
};

// GET /api/groups/:groupId/payout-schedule
const getPayoutSchedule = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const result = await query(
      `SELECT ps.*, u.first_name, u.last_name, u.profile_photo_url
       FROM payout_schedule ps JOIN users u ON u.id = ps.user_id
       WHERE ps.group_id = $1
       ORDER BY ps.cycle_number, ps.payout_order`,
      [groupId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// PATCH /api/groups/:groupId  (group admin only)
const updateGroup = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { name, description, allowLateContributions, lateFeeAmount } = req.body;
    const result = await query(
      `UPDATE groups SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         allow_late_contributions = COALESCE($3, allow_late_contributions),
         late_fee_amount = COALESCE($4, late_fee_amount)
       WHERE id = $5 RETURNING *`,
      [name, description, allowLateContributions, lateFeeAmount, groupId]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
};

// POST /api/groups/:groupId/rotate-invite
const rotateInviteCode = async (req, res, next) => {
  try {
    const newCode = makeInviteCode();
    const result = await query(
      'UPDATE groups SET invite_code = $1 WHERE id = $2 RETURNING invite_code',
      [newCode, req.params.groupId]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
};

// DELETE /api/groups/:groupId/members/:userId  (remove member)
const removeMember = async (req, res, next) => {
  try {
    const { groupId, userId } = req.params;
    await query(
      `UPDATE group_members SET status = 'removed', removed_at = NOW()
       WHERE group_id = $1 AND user_id = $2 AND role != 'owner'`,
      [groupId, userId]
    );
    await notify(userId, 'system', 'Removed from group', 'You have been removed from the group.', { groupId });
    res.json({ success: true, message: 'Member removed' });
  } catch (err) { next(err); }
};

module.exports = {
  createGroup, joinGroup, getMyGroups, getGroupDetail,
  getPayoutSchedule, updateGroup, rotateInviteCode, removeMember
};
