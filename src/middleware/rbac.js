const { query } = require('../config/db');

const ROLE_HIERARCHY = { member: 0, group_admin: 1, admin: 2, super_admin: 3 };

/**
 * Require a minimum platform role
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  const userLevel = ROLE_HIERARCHY[req.user.role] ?? -1;
  const allowed = roles.some(r => ROLE_HIERARCHY[r] <= userLevel);
  if (!allowed) {
    return res.status(403).json({ success: false, message: 'Insufficient permissions' });
  }
  next();
};

/**
 * Require user to be a member of the group (active)
 * Attaches req.groupMembership
 */
const requireGroupMember = async (req, res, next) => {
  const groupId = req.params.groupId || req.body.groupId;
  if (!groupId) {
    return res.status(400).json({ success: false, message: 'Group ID required' });
  }
  try {
    const result = await query(
      `SELECT * FROM group_members
       WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
      [groupId, req.user.id]
    );
    if (!result.rows.length) {
      return res.status(403).json({ success: false, message: 'Not a member of this group' });
    }
    req.groupMembership = result.rows[0];
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Require user to be an owner or admin of the group
 */
const requireGroupAdmin = async (req, res, next) => {
  const groupId = req.params.groupId || req.body.groupId;
  if (!groupId) {
    return res.status(400).json({ success: false, message: 'Group ID required' });
  }
  try {
    const result = await query(
      `SELECT * FROM group_members
       WHERE group_id = $1 AND user_id = $2 AND status = 'active'
       AND role IN ('owner', 'admin')`,
      [groupId, req.user.id]
    );
    if (!result.rows.length) {
      // Platform admins bypass group-level check
      if (['admin', 'super_admin'].includes(req.user.role)) {
        return next();
      }
      return res.status(403).json({ success: false, message: 'Group admin access required' });
    }
    req.groupMembership = result.rows[0];
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { requireRole, requireGroupMember, requireGroupAdmin };
