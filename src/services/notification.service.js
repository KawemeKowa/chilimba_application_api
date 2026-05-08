const { query } = require('../config/db');

/**
 * Send a notification to one or many users
 * @param {string|string[]} userIds
 * @param {string} type - notification_type enum value
 * @param {string} title
 * @param {string} body
 * @param {object} data - extra JSON payload
 */
const notify = async (userIds, type, title, body, data = {}) => {
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  if (!ids.length) return;

  const values = ids.map(
    (id, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`
  );
  const params = ids.flatMap((id) => [id, type, title, body, JSON.stringify(data)]);

  await query(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ${values.join(', ')}`,
    params
  );
};

/**
 * Notify all active members of a group (excluding optionally the actor)
 */
const notifyGroup = async (groupId, type, title, body, data = {}, excludeUserId = null) => {
  const result = await query(
    `SELECT user_id FROM group_members WHERE group_id = $1 AND status = 'active'
     ${excludeUserId ? 'AND user_id != $2' : ''}`,
    excludeUserId ? [groupId, excludeUserId] : [groupId]
  );
  const ids = result.rows.map((r) => r.user_id);
  if (ids.length) await notify(ids, type, title, body, data);
};

module.exports = { notify, notifyGroup };
