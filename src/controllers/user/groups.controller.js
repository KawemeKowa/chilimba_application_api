const { query, withTransaction } = require('../../config/db');
const { generatePayoutSchedule, generateContributionRound } = require('../../services/chilimba.service');
const { notify, notifyGroup } = require('../../services/notification.service');
const { paginate, paginatedResponse } = require('../../middleware/errorHandler');
const slugify = require('slugify');
const crypto = require('crypto');
const email = require('../../services/email.service');
const storage = require('../../services/storage.service');

// Generate unique invite code
const makeInviteCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

// Map DB snake_case to camelCase for group rows
function normalizeGroup(g) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    slug: g.slug,
    status: g.status,
    monthlyAmount: g.monthly_amount,
    currency: g.currency,
    maxMembers: g.max_members,
    memberCount: parseInt(g.active_members ?? g.member_count ?? 0),
    currentCycle: g.current_cycle,
    contributionDay: g.contribution_day,
    payoutDay: g.payout_day,
    minApprovalsWithdrawal: g.min_approvals_withdrawal,
    allowLateContributions: g.allow_late_contributions,
    lateFeeAmount: g.late_fee_amount,
    inviteCode: g.invite_code,
    coverPhotoUrl: g.cover_photo_url,
    createdBy: g.created_by,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
    myRole: g.my_role,
    payoutOrder: g.payout_order,
  };
}

function normalizeMember(m) {
  return {
    id: m.id,
    groupId: m.group_id,
    userId: m.user_id,
    role: m.role,
    status: m.status,
    payoutOrder: m.payout_order,
    joinedAt: m.joined_at,
    firstName: m.first_name,
    lastName: m.last_name,
    email: m.email,
    phone: m.phone,
    photoUrl: m.profile_photo_url,
  };
}

// POST /api/groups
const createGroup = async (req, res, next) => {
  try {
    const {
      name, description, monthlyAmount, maxMembers = 12,
      contributionDay = 1, payoutDay = 25, minApprovalsWithdrawal = 2,
      allowLateContributions = true, lateFeeAmount = 0, currency = 'ZMW'
    } = req.body;

    const existing = await query(
      `SELECT id FROM groups WHERE LOWER(name) = LOWER($1) LIMIT 1`,
      [name]
    );
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: `A group named "${name}" already exists. Please choose a different name.` });
    }

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

    if (req.file) {
      const url = await storage.uploadFile(
        `groups/${result.id}/cover`,
        req.file.buffer,
        req.file.mimetype
      );
      await query('UPDATE groups SET cover_photo_url = $1 WHERE id = $2', [url, result.id]);
      result.cover_photo_url = url;
    }

    res.status(201).json({ success: true, data: result });
    email.sendGroupCreated(req.user, result);
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
    email.sendJoinedGroup(req.user, group);
    query(
      `SELECT u.email, u.first_name FROM users u
       JOIN group_members gm ON gm.user_id = u.id
       WHERE gm.group_id = $1 AND gm.role = 'owner' LIMIT 1`,
      [group.id]
    ).then(({ rows }) => {
      if (rows.length) email.sendMemberJoined(rows[0].email, rows[0].first_name, req.user, group);
    }).catch(() => {});
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
    res.json({ success: true, data: result.rows.map(normalizeGroup) });
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
      `SELECT gm.*, u.first_name, u.last_name, u.email, u.phone, u.profile_photo_url
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1 AND gm.status = 'active'
       ORDER BY gm.payout_order ASC`,
      [groupId]
    );

    res.json({
      success: true,
      data: { ...normalizeGroup(groupResult.rows[0]), members: membersResult.rows.map(normalizeMember) }
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

    let coverPhotoUrl;
    if (req.file) {
      coverPhotoUrl = await storage.uploadFile(
        `groups/${groupId}/cover`,
        req.file.buffer,
        req.file.mimetype
      );
    }

    const result = await query(
      `UPDATE groups SET
         name                     = COALESCE($1, name),
         description              = COALESCE($2, description),
         allow_late_contributions = COALESCE($3, allow_late_contributions),
         late_fee_amount          = COALESCE($4, late_fee_amount),
         cover_photo_url          = COALESCE($5, cover_photo_url)
       WHERE id = $6 RETURNING *`,
      [name || null, description || null, allowLateContributions ?? null, lateFeeAmount ?? null, coverPhotoUrl || null, groupId]
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

    const [userResult, groupResult] = await Promise.all([
      query('SELECT first_name, last_name, email FROM users WHERE id = $1', [userId]),
      query('SELECT name FROM groups WHERE id = $1', [groupId]),
    ]);

    await query(
      `UPDATE group_members SET status = 'removed', removed_at = NOW()
       WHERE group_id = $1 AND user_id = $2 AND role != 'owner'`,
      [groupId, userId]
    );
    await notify(userId, 'system', 'Removed from group', 'You have been removed from the group.', { groupId });
    res.json({ success: true, message: 'Member removed' });

    if (userResult.rows.length && groupResult.rows.length) {
      email.sendMemberRemoved(userResult.rows[0], groupResult.rows[0]);
    }
  } catch (err) { next(err); }
};

// POST /api/groups/:groupId/invite  — send email invitation
const inviteMember = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { email: inviteeEmail } = req.body;

    const [groupResult, inviterResult] = await Promise.all([
      query('SELECT * FROM groups WHERE id = $1', [groupId]),
      query('SELECT * FROM users WHERE id = $1', [req.user.id]),
    ]);
    const group = groupResult.rows[0];
    const inviter = inviterResult.rows[0];
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    // Prevent inviting existing active members
    const memberCheck = await query(
      `SELECT id FROM group_members
       WHERE group_id = $1 AND status = 'active'
         AND user_id = (SELECT id FROM users WHERE email = $2 LIMIT 1)`,
      [groupId, inviteeEmail]
    );
    if (memberCheck.rows.length) {
      return res.status(409).json({ success: false, message: 'This person is already a member of the group.' });
    }

    // Cancel any existing pending invite to the same email for this group
    await query(
      `UPDATE group_invitations SET status = 'expired'
       WHERE group_id = $1 AND email = $2 AND status = 'pending'`,
      [groupId, inviteeEmail]
    );

    const token = require('crypto').randomBytes(32).toString('hex');
    await query(
      `INSERT INTO group_invitations (group_id, invited_by, email, token)
       VALUES ($1, $2, $3, $4)`,
      [groupId, req.user.id, inviteeEmail, token]
    );

    await email.sendGroupInvitation(inviter, inviteeEmail, group, token);
    res.json({ success: true, message: `Invitation sent to ${inviteeEmail}` });
  } catch (err) { next(err); }
};

// GET /api/groups/invitations/:token  — get invitation details (public)
const getInvitation = async (req, res, next) => {
  try {
    const { token } = req.params;
    const result = await query(
      `SELECT gi.*, g.name AS group_name, g.description AS group_description,
              g.monthly_amount, g.max_members, g.payout_day, g.currency,
              u.first_name AS inviter_first, u.last_name AS inviter_last
       FROM group_invitations gi
       JOIN groups g ON g.id = gi.group_id
       JOIN users u ON u.id = gi.invited_by
       WHERE gi.token = $1`,
      [token]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Invitation not found.' });
    }
    const inv = result.rows[0];
    if (inv.status !== 'pending' || new Date(inv.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: 'This invitation has expired or already been used.' });
    }
    const userCheck = await query('SELECT id FROM users WHERE email = $1', [inv.email]);
    res.json({
      success: true, data: {
        token: inv.token,
        email: inv.email,
        status: inv.status,
        expiresAt: inv.expires_at,
        userExists: userCheck.rows.length > 0,
        group: {
          id: inv.group_id,
          name: inv.group_name,
          description: inv.group_description,
          monthlyAmount: inv.monthly_amount,
          maxMembers: inv.max_members,
          payoutDay: inv.payout_day,
          currency: inv.currency,
        },
        invitedBy: { firstName: inv.inviter_first, lastName: inv.inviter_last },
      }
    });
  } catch (err) { next(err); }
};

// POST /api/groups/invitations/:token/accept  — accept invitation (auth required)
const acceptInvitation = async (req, res, next) => {
  try {
    const { token } = req.params;
    const result = await query(
      `SELECT gi.id, gi.token, gi.group_id, gi.invited_by, gi.email,
              gi.status AS invitation_status, gi.expires_at,
              g.name, g.status AS group_status,
              g.monthly_amount, g.contribution_day, g.payout_day
       FROM group_invitations gi
       JOIN groups g ON g.id = gi.group_id
       WHERE gi.token = $1`,
      [token]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Invitation not found.' });
    }
    const inv = result.rows[0];
    if (inv.invitation_status !== 'pending' || new Date(inv.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: 'This invitation has expired or already been used.' });
    }

    // Check email matches the logged-in user
    const userResult = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    if (user.email.toLowerCase() !== inv.email.toLowerCase()) {
      return res.status(403).json({ success: false, message: 'This invitation was sent to a different email address.' });
    }

    // Check not already a member
    const memberCheck = await query(
      `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
      [inv.group_id, req.user.id]
    );
    if (memberCheck.rows.length) {
      await query(`UPDATE group_invitations SET status = 'accepted', accepted_at = NOW() WHERE token = $1`, [token]);
      return res.json({ success: true, message: 'You are already a member of this group.', groupId: inv.group_id });
    }

    await withTransaction(async (client) => {
      const memberCount = await client.query(
        `SELECT COUNT(*) FROM group_members WHERE group_id = $1 AND status = 'active'`,
        [inv.group_id]
      );
      const payoutOrder = parseInt(memberCount.rows[0].count) + 1;

      await client.query(
        `INSERT INTO group_members (group_id, user_id, role, status, payout_order, joined_at)
         VALUES ($1, $2, 'member', 'active', $3, NOW())
         ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'active', joined_at = NOW()`,
        [inv.group_id, req.user.id, payoutOrder]
      );
      await client.query(
        `UPDATE group_invitations SET status = 'accepted', accepted_at = NOW() WHERE token = $1`,
        [token]
      );
    });

    notify(req.user.id, 'group', `Joined ${inv.name}`, 'You have joined the group via email invitation.', { groupId: inv.group_id }).catch(() => {});
    email.sendJoinedGroup(user, inv).catch(() => {});

    res.json({ success: true, message: `You have joined ${inv.name}!`, groupId: inv.group_id });
  } catch (err) { next(err); }
};

// POST /api/groups/invitations/:token/decline  — decline invitation
const declineInvitation = async (req, res, next) => {
  try {
    const { token } = req.params;
    const result = await query(
      `UPDATE group_invitations SET status = 'declined'
       WHERE token = $1 AND status = 'pending'
       RETURNING id`,
      [token]
    );
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Invitation not found or already resolved.' });
    }
    res.json({ success: true, message: 'Invitation declined.' });
  } catch (err) { next(err); }
};

module.exports = {
  createGroup, joinGroup, getMyGroups, getGroupDetail,
  getPayoutSchedule, updateGroup, rotateInviteCode, removeMember,
  inviteMember, getInvitation, acceptInvitation, declineInvitation,
};
