const { query } = require('../../config/db');
const { paginate, paginatedResponse } = require('../../middleware/errorHandler');

// GET /api/superadmin/analytics/overview
const getPlatformOverview = async (req, res, next) => {
  try {
    const [users, groups, transactions, wallets, committee] = await Promise.all([
      query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'active') AS active,
          COUNT(*) FILTER (WHERE status = 'pending_verification') AS pending_verification,
          COUNT(*) FILTER (WHERE status = 'suspended') AS suspended,
          COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) AS registered_today,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS registered_last_7d,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS registered_last_30d
        FROM users`),
      query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'active') AS active,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE status = 'dissolved') AS dissolved,
          AVG(max_members) AS avg_max_members,
          AVG(monthly_amount) AS avg_monthly_amount
        FROM groups`),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'completed') AS total_completed,
          COALESCE(SUM(amount) FILTER (WHERE status = 'completed'), 0) AS total_volume,
          COALESCE(SUM(amount) FILTER (WHERE type = 'fee' AND status = 'completed'), 0) AS fee_revenue,
          COALESCE(SUM(amount) FILTER (WHERE type = 'contribution' AND status = 'completed'), 0) AS contributions_volume,
          COALESCE(SUM(amount) FILTER (WHERE type = 'payout' AND status = 'completed'), 0) AS payouts_volume,
          COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE) AS txns_today
        FROM transactions`),
      query(`
        SELECT COALESCE(SUM(balance), 0) AS total_balance_on_platform
        FROM wallets WHERE is_frozen = FALSE`),
      query(`
        SELECT
          COUNT(*) AS total_campaigns,
          COALESCE(SUM(raised_amount), 0) AS total_raised
        FROM committee_pools`),
    ]);

    res.json({
      success: true,
      data: {
        users: users.rows[0],
        groups: groups.rows[0],
        transactions: transactions.rows[0],
        wallets: wallets.rows[0],
        committee: committee.rows[0],
        generatedAt: new Date().toISOString(),
      }
    });
  } catch (err) { next(err); }
};

// GET /api/superadmin/analytics/daily?days=30
const getDailyStats = async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const result = await query(
      `SELECT * FROM v_platform_daily_stats
       WHERE stat_date >= CURRENT_DATE - INTERVAL '${days} days'
       ORDER BY stat_date DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// GET /api/superadmin/analytics/groups
const getGroupStats = async (req, res, next) => {
  try {
    const { limit, offset, page } = paginate(req);
    const total = await query('SELECT COUNT(*) FROM v_group_summary');
    const result = await query(
      `SELECT * FROM v_group_summary ORDER BY total_collected DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// GET /api/superadmin/analytics/compliance
const getMemberCompliance = async (req, res, next) => {
  try {
    const { groupId } = req.query;
    const { limit, offset, page } = paginate(req);
    const params = groupId ? [groupId] : [];
    const where = groupId ? 'WHERE group_id = $1' : '';

    const total = await query(`SELECT COUNT(*) FROM v_member_compliance ${where}`, params);
    params.push(limit, offset);
    const result = await query(
      `SELECT * FROM v_member_compliance ${where}
       ORDER BY compliance_rate ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// GET /api/superadmin/analytics/revenue?groupBy=month
const getRevenueBreakdown = async (req, res, next) => {
  try {
    const { groupBy = 'month', months = 12 } = req.query;

    const truncUnit = ['day', 'week', 'month', 'quarter', 'year'].includes(groupBy)
      ? groupBy : 'month';

    const result = await query(
      `SELECT
         DATE_TRUNC('${truncUnit}', created_at) AS period,
         SUM(amount) FILTER (WHERE type = 'fee') AS fee_revenue,
         SUM(amount) FILTER (WHERE type = 'contribution') AS contribution_volume,
         SUM(amount) FILTER (WHERE type = 'payout') AS payout_volume,
         COUNT(*) FILTER (WHERE type = 'contribution') AS contribution_count
       FROM transactions
       WHERE status = 'completed'
         AND created_at >= NOW() - INTERVAL '${parseInt(months)} months'
       GROUP BY DATE_TRUNC('${truncUnit}', created_at)
       ORDER BY period DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// GET /api/superadmin/analytics/top-groups
const getTopGroups = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT g.id, g.name, g.status, g.monthly_amount, g.current_cycle,
              COUNT(DISTINCT gm.user_id) FILTER (WHERE gm.status = 'active') AS active_members,
              COALESCE(SUM(c.amount_paid), 0) AS total_collected,
              COUNT(c.id) FILTER (WHERE c.status = 'paid') AS paid_contributions,
              COUNT(c.id) FILTER (WHERE c.status IN ('pending', 'late') AND c.due_date < NOW()) AS overdue
       FROM groups g
       LEFT JOIN group_members gm ON gm.group_id = g.id
       LEFT JOIN contributions c ON c.group_id = g.id
       GROUP BY g.id
       ORDER BY total_collected DESC
       LIMIT 20`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// GET /api/superadmin/analytics/user-growth
const getUserGrowth = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         DATE_TRUNC('month', created_at) AS month,
         COUNT(*) AS new_users,
         COUNT(*) FILTER (WHERE id_verified = TRUE) AS verified_users,
         SUM(COUNT(*)) OVER (ORDER BY DATE_TRUNC('month', created_at)) AS cumulative_users
       FROM users
       WHERE created_at >= NOW() - INTERVAL '12 months'
       GROUP BY DATE_TRUNC('month', created_at)
       ORDER BY month DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// ─── PLATFORM SETTINGS ────────────────────────────────────────────────────────

// GET /api/superadmin/settings
const getSettings = async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM platform_settings ORDER BY key');
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// PATCH /api/superadmin/settings/:key
const updateSetting = async (req, res, next) => {
  try {
    const { value } = req.body;
    const result = await query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = NOW()
       RETURNING *`,
      [req.params.key, value, req.user.id]
    );
    await query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, changes, ip_address)
       VALUES ($1, 'settings_changed', 'platform_settings', $2, $3)`,
      [req.user.id, JSON.stringify({ key: req.params.key, value }), req.ip]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
};

// ─── AUDIT LOGS ───────────────────────────────────────────────────────────────

// GET /api/superadmin/audit-logs
const getAuditLogs = async (req, res, next) => {
  try {
    const { action, actorId, entityType, startDate, endDate } = req.query;
    const { limit, offset, page } = paginate(req);
    const params = [];
    const conditions = [];

    if (action) { params.push(action); conditions.push(`al.action = $${params.length}`); }
    if (actorId) { params.push(actorId); conditions.push(`al.actor_id = $${params.length}`); }
    if (entityType) { params.push(entityType); conditions.push(`al.entity_type = $${params.length}`); }
    if (startDate) { params.push(startDate); conditions.push(`al.created_at >= $${params.length}`); }
    if (endDate) { params.push(endDate); conditions.push(`al.created_at <= $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = await query(`SELECT COUNT(*) FROM audit_logs al ${where}`, params);
    params.push(limit, offset);

    const result = await query(
      `SELECT al.*, u.first_name || ' ' || u.last_name AS actor_name
       FROM audit_logs al LEFT JOIN users u ON u.id = al.actor_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// GET /api/superadmin/health
const getHealthCheck = async (req, res, next) => {
  try {
    const dbCheck = await query('SELECT NOW() AS db_time, version() AS db_version');
    const pendingPayouts = await query(
      `SELECT COUNT(*) FROM payout_schedule WHERE status = 'scheduled' AND scheduled_date <= NOW()`
    );
    const failedTxns = await query(
      `SELECT COUNT(*) FROM transactions WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours'`
    );
    const pendingKyc = await query(
      `SELECT COUNT(*) FROM users WHERE status = 'pending_verification'`
    );
    const expiredWithdrawals = await query(
      `SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'pending_approval' AND expires_at < NOW()`
    );

    res.json({
      success: true,
      data: {
        status: 'healthy',
        database: { connected: true, time: dbCheck.rows[0].db_time },
        alerts: {
          pendingPayouts: parseInt(pendingPayouts.rows[0].count),
          failedTransactions24h: parseInt(failedTxns.rows[0].count),
          pendingKycVerifications: parseInt(pendingKyc.rows[0].count),
          expiredWithdrawals: parseInt(expiredWithdrawals.rows[0].count),
        }
      }
    });
  } catch (err) { next(err); }
};

// GET /api/superadmin/admins  (list all admin/superadmin users)
const listAdmins = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, first_name, last_name, email, role, status, last_login_at, created_at
       FROM users WHERE role IN ('admin', 'super_admin')
       ORDER BY role, created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// PATCH /api/superadmin/admins/:userId/role
const updateUserRole = async (req, res, next) => {
  try {
    const { role } = req.body;
    const validRoles = ['member', 'admin', 'super_admin'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, message: `Role must be one of: ${validRoles.join(', ')}` });
    }
    await query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.userId]);
    await query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, changes, ip_address)
       VALUES ($1, 'user_updated', 'user', $2, $3, $4)`,
      [req.user.id, req.params.userId, JSON.stringify({ role }), req.ip]
    );
    res.json({ success: true, message: `User role updated to ${role}` });
  } catch (err) { next(err); }
};

module.exports = {
  getPlatformOverview, getDailyStats, getGroupStats, getMemberCompliance,
  getRevenueBreakdown, getTopGroups, getUserGrowth,
  getSettings, updateSetting,
  getAuditLogs, getHealthCheck, listAdmins, updateUserRole
};
