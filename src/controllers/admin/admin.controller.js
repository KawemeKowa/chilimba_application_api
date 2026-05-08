const { query, withTransaction } = require('../../config/db');
const { disbursePayout } = require('../../services/chilimba.service');
const { notify, notifyGroup } = require('../../services/notification.service');
const { paginate, paginatedResponse } = require('../../middleware/errorHandler');
const email = require('../../services/email.service');

// ─── USER MANAGEMENT ──────────────────────────────────────────────────────────

// GET /api/admin/users
const listUsers = async (req, res, next) => {
  try {
    const { status, search, role } = req.query;
    const { limit, offset, page } = paginate(req);
    const params = [];
    const conditions = [];

    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (role) { params.push(role); conditions.push(`role = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(first_name ILIKE $${params.length} OR last_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = await query(`SELECT COUNT(*) FROM users ${where}`, params);
    params.push(limit, offset);

    const result = await query(
      `SELECT id, first_name, last_name, email, phone, role, status,
              id_verified, last_login_at, created_at
       FROM users ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// GET /api/admin/users/:userId
const getUserDetail = async (req, res, next) => {
  try {
    const user = await query(
      `SELECT id, first_name, last_name, email, phone, role, status,
              date_of_birth, id_type, id_number, id_verified, last_login_at, created_at
       FROM users WHERE id = $1`,
      [req.params.userId]
    );
    if (!user.rows.length) return res.status(404).json({ success: false, message: 'User not found' });

    const groups = await query(
      `SELECT g.id, g.name, gm.role, gm.status, gm.joined_at
       FROM group_members gm JOIN groups g ON g.id = gm.group_id
       WHERE gm.user_id = $1`,
      [req.params.userId]
    );

    res.json({ success: true, data: { ...user.rows[0], groups: groups.rows } });
  } catch (err) { next(err); }
};

// PATCH /api/admin/users/:userId/status
const updateUserStatus = async (req, res, next) => {
  try {
    const { status, reason } = req.body;
    const valid = ['active', 'suspended', 'banned'];
    if (!valid.includes(status)) {
      return res.status(400).json({ success: false, message: `Status must be one of: ${valid.join(', ')}` });
    }

    const userResult = await query(
      'SELECT first_name, last_name, email FROM users WHERE id = $1',
      [req.params.userId]
    );

    await query('UPDATE users SET status = $1 WHERE id = $2', [status, req.params.userId]);

    await query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, changes, ip_address)
       VALUES ($1, $2, 'user', $3, $4, $5)`,
      [req.user.id,
       status === 'banned' ? 'user_banned' : 'user_suspended',
       req.params.userId,
       JSON.stringify({ status, reason }),
       req.ip]
    );

    await notify(req.params.userId, 'system', 'Account Status Update', `Your account has been ${status}.`, { reason });
    res.json({ success: true, message: `User ${status}` });

    if (userResult.rows.length && status !== 'active') {
      email.sendAccountStatusChanged(userResult.rows[0], status, reason);
    }
  } catch (err) { next(err); }
};

// POST /api/admin/users/:userId/verify
const verifyUser = async (req, res, next) => {
  try {
    const userResult = await query(
      'SELECT first_name, last_name, email FROM users WHERE id = $1',
      [req.params.userId]
    );

    await query(
      'UPDATE users SET id_verified = TRUE, status = $1 WHERE id = $2',
      ['active', req.params.userId]
    );
    await query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, ip_address)
       VALUES ($1, 'user_updated', 'user', $2, $3)`,
      [req.user.id, req.params.userId, req.ip]
    );
    res.json({ success: true, message: 'User verified and activated' });

    if (userResult.rows.length) email.sendAccountVerified(userResult.rows[0]);
  } catch (err) { next(err); }
};

// ─── GROUP MANAGEMENT ─────────────────────────────────────────────────────────

// GET /api/admin/groups
const listGroups = async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const { limit, offset, page } = paginate(req);
    const params = [];
    const conditions = [];

    if (status) { params.push(status); conditions.push(`g.status = $${params.length}`); }
    if (search) { params.push(`%${search}%`); conditions.push(`g.name ILIKE $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = await query(`SELECT COUNT(*) FROM groups g ${where}`, params);
    params.push(limit, offset);

    const result = await query(
      `SELECT g.*,
              COUNT(DISTINCT gm.user_id) FILTER (WHERE gm.status = 'active') AS active_members,
              u.first_name || ' ' || u.last_name AS owner_name
       FROM groups g
       LEFT JOIN group_members gm ON gm.group_id = g.id
       LEFT JOIN users u ON u.id = g.created_by
       ${where}
       GROUP BY g.id, u.first_name, u.last_name
       ORDER BY g.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// PATCH /api/admin/groups/:groupId/status
const updateGroupStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    await query('UPDATE groups SET status = $1 WHERE id = $2', [status, req.params.groupId]);
    const action = status === 'dissolved' ? 'group_dissolved' : 'group_created';
    await query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, ip_address)
       VALUES ($1, $2, 'group', $3, $4)`,
      [req.user.id, action, req.params.groupId, req.ip]
    );
    res.json({ success: true, message: `Group status updated to ${status}` });
  } catch (err) { next(err); }
};

// ─── PAYOUTS ──────────────────────────────────────────────────────────────────

// GET /api/admin/payouts/pending
const getPendingPayouts = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT ps.*, g.name AS group_name, u.first_name, u.last_name
       FROM payout_schedule ps
       JOIN groups g ON g.id = ps.group_id
       JOIN users u ON u.id = ps.user_id
       WHERE ps.status = 'scheduled' AND ps.scheduled_date <= NOW()
       ORDER BY ps.scheduled_date ASC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// POST /api/admin/payouts/:payoutScheduleId/disburse
const processPayoutDisbursement = async (req, res, next) => {
  try {
    const result = await disbursePayout(req.params.payoutScheduleId, req.user.id);
    res.json({
      success: true,
      message: 'Payout disbursed',
      data: { netPayout: result.netPayout, feeCharged: result.feeCharged }
    });

    query('SELECT first_name, last_name, email FROM users WHERE id = $1', [result.payout.user_id])
      .then(({ rows }) => {
        if (rows.length) {
          email.sendPayoutDisbursed(rows[0], result.payout, { name: result.payout.group_name, id: result.payout.group_id });
        }
      }).catch(() => {});
  } catch (err) { next(err); }
};

// ─── WITHDRAWALS ──────────────────────────────────────────────────────────────

// GET /api/admin/withdrawals
const listWithdrawals = async (req, res, next) => {
  try {
    const { status } = req.query;
    const { limit, offset, page } = paginate(req);
    const params = status ? [status] : [];
    const where = status ? 'WHERE wr.status = $1' : '';

    const total = await query(`SELECT COUNT(*) FROM withdrawal_requests wr ${where}`, params);
    params.push(limit, offset);

    const result = await query(
      `SELECT wr.*, g.name AS group_name,
              u.first_name || ' ' || u.last_name AS requested_by_name
       FROM withdrawal_requests wr
       JOIN groups g ON g.id = wr.group_id
       JOIN users u ON u.id = wr.requested_by
       ${where}
       ORDER BY wr.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// ─── FEES ─────────────────────────────────────────────────────────────────────

// GET /api/admin/fees
const getFees = async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM fees_config ORDER BY applies_to');
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// PATCH /api/admin/fees/:feeId
const updateFee = async (req, res, next) => {
  try {
    const { value, isActive } = req.body;
    const result = await query(
      `UPDATE fees_config SET
         value = COALESCE($1, value),
         is_active = COALESCE($2, is_active)
       WHERE id = $3 RETURNING *`,
      [value, isActive, req.params.feeId]
    );
    await query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, changes, ip_address)
       VALUES ($1, 'fee_updated', 'fees_config', $2, $3, $4)`,
      [req.user.id, req.params.feeId, JSON.stringify({ value, isActive }), req.ip]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
};

// ─── BROADCAST NOTIFICATION ───────────────────────────────────────────────────

// POST /api/admin/notifications/broadcast
const broadcastNotification = async (req, res, next) => {
  try {
    const { title, body, targetRole } = req.body;
    const params = targetRole ? [targetRole] : [];
    const where = targetRole ? 'WHERE role = $1 AND status = $2' : 'WHERE status = $1';
    if (targetRole) params.push('active'); else params.push('active');

    const users = await query(`SELECT id FROM users ${where}`, params);
    const ids = users.rows.map(u => u.id);

    if (ids.length) {
      const { notify: _notify } = require('../../services/notification.service');
      await _notify(ids, 'system', title, body, {});
    }

    res.json({ success: true, message: `Notification sent to ${ids.length} users` });
  } catch (err) { next(err); }
};

module.exports = {
  listUsers, getUserDetail, updateUserStatus, verifyUser,
  listGroups, updateGroupStatus,
  getPendingPayouts, processPayoutDisbursement,
  listWithdrawals,
  getFees, updateFee,
  broadcastNotification
};
