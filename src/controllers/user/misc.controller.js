const { query } = require('../../config/db');
const { paginate, paginatedResponse } = require('../../middleware/errorHandler');

// ─── GROUP MESSAGES ────────────────────────────────────────────────────────────

// POST /api/groups/:groupId/messages
const postMessage = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { content, parentId } = req.body;

    const result = await query(
      `INSERT INTO group_messages (group_id, user_id, content, parent_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [groupId, req.user.id, content, parentId || null]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
};

// GET /api/groups/:groupId/messages
const getMessages = async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { limit, offset, page } = paginate(req);

    const total = await query(
      `SELECT COUNT(*) FROM group_messages WHERE group_id = $1 AND is_deleted = FALSE AND parent_id IS NULL`,
      [groupId]
    );
    const result = await query(
      `SELECT gm.*, u.first_name, u.last_name, u.profile_photo_url,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', r.id, 'content', r.content,
                    'userId', r.user_id, 'createdAt', r.created_at
                  )
                ) FILTER (WHERE r.id IS NOT NULL), '[]'
              ) AS replies
       FROM group_messages gm
       JOIN users u ON u.id = gm.user_id
       LEFT JOIN group_messages r ON r.parent_id = gm.id AND r.is_deleted = FALSE
       WHERE gm.group_id = $1 AND gm.is_deleted = FALSE AND gm.parent_id IS NULL
       GROUP BY gm.id, u.first_name, u.last_name, u.profile_photo_url
       ORDER BY gm.is_pinned DESC, gm.created_at DESC
       LIMIT $2 OFFSET $3`,
      [groupId, limit, offset]
    );

    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// DELETE /api/messages/:messageId
const deleteMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    await query(
      `UPDATE group_messages SET is_deleted = TRUE WHERE id = $1 AND user_id = $2`,
      [messageId, req.user.id]
    );
    res.json({ success: true, message: 'Message deleted' });
  } catch (err) { next(err); }
};

// ─── WALLET ────────────────────────────────────────────────────────────────────

// GET /api/wallet
const getWallet = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT w.*, g.name AS group_name
       FROM wallets w LEFT JOIN groups g ON g.id = w.group_id
       WHERE w.owner_id = $1 ORDER BY w.type, w.created_at`,
      [req.user.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// GET /api/wallet/transactions
const getTransactions = async (req, res, next) => {
  try {
    const { walletId, type, startDate, endDate } = req.query;
    const { limit, offset, page } = paginate(req);

    // Verify wallet belongs to user
    const params = [req.user.id];
    let where = 'w.owner_id = $1';

    if (walletId) { params.push(walletId); where += ` AND t.wallet_id = $${params.length}`; }
    if (type) { params.push(type); where += ` AND t.type = $${params.length}`; }
    if (startDate) { params.push(startDate); where += ` AND t.created_at >= $${params.length}`; }
    if (endDate) { params.push(endDate); where += ` AND t.created_at <= $${params.length}`; }

    const total = await query(
      `SELECT COUNT(*) FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE ${where}`,
      params
    );
    params.push(limit, offset);
    const result = await query(
      `SELECT t.* FROM transactions t JOIN wallets w ON w.id = t.wallet_id
       WHERE ${where} ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// ─── NOTIFICATIONS ─────────────────────────────────────────────────────────────

// GET /api/notifications
const getNotifications = async (req, res, next) => {
  try {
    const { unreadOnly } = req.query;
    const { limit, offset, page } = paginate(req);
    const params = [req.user.id];
    let whereExtra = '';
    if (unreadOnly === 'true') { whereExtra = ' AND is_read = FALSE'; }

    const total = await query(
      `SELECT COUNT(*) FROM notifications WHERE user_id = $1 ${whereExtra}`,
      params
    );
    const result = await query(
      `SELECT * FROM notifications WHERE user_id = $1 ${whereExtra}
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    paginatedResponse(res, result.rows, parseInt(total.rows[0].count), { page, limit });
  } catch (err) { next(err); }
};

// PATCH /api/notifications/read-all
const markAllRead = async (req, res, next) => {
  try {
    await query(
      'UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE user_id = $1 AND is_read = FALSE',
      [req.user.id]
    );
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) { next(err); }
};

// PATCH /api/notifications/:id/read
const markRead = async (req, res, next) => {
  try {
    await query(
      'UPDATE notifications SET is_read = TRUE, read_at = NOW() WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
};

module.exports = {
  postMessage, getMessages, deleteMessage,
  getWallet, getTransactions,
  getNotifications, markAllRead, markRead
};
