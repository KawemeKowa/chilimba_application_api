const { query, withTransaction } = require('../../config/db');
const { notifyGroup } = require('../../services/notification.service');
const { paginate, paginatedResponse } = require('../../middleware/errorHandler');

// POST /api/groups/:groupId/committees
const createCommitteePool = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { title, description, category, targetAmount, closesAt, beneficiary } = req.body;

    const result = await query(
      `INSERT INTO committee_pools
         (group_id, created_by, title, description, category, target_amount, closes_at, beneficiary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [groupId, req.user.id, title, description, category, targetAmount || null, closesAt || null, beneficiary || null]
    );
    const pool = result.rows[0];

    const groupResult = await query('SELECT name FROM groups WHERE id = $1', [groupId]);
    await notifyGroup(
      groupId, 'committee_created',
      `${groupResult.rows[0].name} – New Campaign: ${title}`,
      `${description.slice(0, 100)}...`,
      { poolId: pool.id }
    );

    res.status(201).json({ success: true, data: pool });
  } catch (err) { next(err); }
};

// GET /api/groups/:groupId/committees
const getCommitteePools = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { status } = req.query;
    const { limit, offset, page } = paginate(req);

    const params = [groupId];
    let whereExtra = '';
    if (status) { params.push(status); whereExtra = ` AND cp.status = $${params.length}`; }

    const total = await query(
      `SELECT COUNT(*) FROM committee_pools cp WHERE cp.group_id = $1 ${whereExtra}`,
      params
    );
    params.push(limit, offset);
    const result = await query(
      `SELECT cp.*,
              u.first_name || ' ' || u.last_name AS created_by_name,
              COUNT(DISTINCT cc.id) AS contribution_count
       FROM committee_pools cp
       JOIN users u ON u.id = cp.created_by
       LEFT JOIN committee_contributions cc ON cc.pool_id = cp.id
       WHERE cp.group_id = $1 ${whereExtra}
       GROUP BY cp.id, u.first_name, u.last_name
       ORDER BY cp.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// POST /api/committees/:poolId/contribute
const contributeToPool = async (req, res, next) => {
  try {
    const { poolId } = req.params;
    const { amount, message, isAnonymous = false } = req.body;

    await withTransaction(async (client) => {
      const poolResult = await client.query(
        'SELECT * FROM committee_pools WHERE id = $1 AND status = $2 FOR UPDATE',
        [poolId, 'active']
      );
      if (!poolResult.rows.length) throw Object.assign(new Error('Campaign not found or closed'), { status: 404 });

      const pool = poolResult.rows[0];
      if (pool.closes_at && new Date() > new Date(pool.closes_at)) {
        throw Object.assign(new Error('Campaign has closed'), { status: 409 });
      }

      await client.query(
        `INSERT INTO committee_contributions (pool_id, user_id, amount, message, is_anonymous)
         VALUES ($1, $2, $3, $4, $5)`,
        [poolId, req.user.id, amount, message || null, isAnonymous]
      );

      await client.query(
        'UPDATE committee_pools SET raised_amount = raised_amount + $1 WHERE id = $2',
        [amount, poolId]
      );

      // Notify group
      const displayName = isAnonymous ? 'Anonymous' : `${req.user.first_name} ${req.user.last_name}`;
      await notifyGroup(
        pool.group_id, 'committee_contribution',
        `${pool.title} – New Contribution`,
        `${displayName} contributed ZMW ${amount}.`,
        { poolId, amount }
      );
    });

    res.json({ success: true, message: 'Contribution added to campaign' });
  } catch (err) { next(err); }
};

// GET /api/committees/:poolId/contributors
const getContributors = async (req, res, next) => {
  try {
    const { poolId } = req.params;
    const result = await query(
      `SELECT cc.amount, cc.message, cc.is_anonymous, cc.created_at,
              CASE WHEN cc.is_anonymous THEN NULL ELSE u.first_name END AS first_name,
              CASE WHEN cc.is_anonymous THEN NULL ELSE u.last_name END AS last_name
       FROM committee_contributions cc JOIN users u ON u.id = cc.user_id
       WHERE cc.pool_id = $1
       ORDER BY cc.created_at DESC`,
      [poolId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// PATCH /api/committees/:poolId/close
const closePool = async (req, res, next) => {
  try {
    const { poolId } = req.params;
    await query(
      `UPDATE committee_pools SET status = 'closed' WHERE id = $1 AND created_by = $2`,
      [poolId, req.user.id]
    );
    res.json({ success: true, message: 'Campaign closed' });
  } catch (err) { next(err); }
};

module.exports = { createCommitteePool, getCommitteePools, contributeToPool, getContributors, closePool };
