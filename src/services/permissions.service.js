const { query } = require('../config/db');

// Catalog of every permission the frontend/backend can gate on.
// Adding a new entry here makes it assignable in the roles admin UI.
const PERMISSIONS_CATALOG = [
  { key: 'users.manage',          label: 'Manage users (platform)' },
  { key: 'groups.manage',         label: 'Manage groups (platform)' },
  { key: 'finance.view',          label: 'View finance overview' },
  { key: 'roles.manage',          label: 'Manage roles & permissions' },
  { key: 'wallet.deposit',        label: 'Deposit into wallets' },
  { key: 'group.edit',            label: 'Edit group settings' },
  { key: 'group.invite',          label: 'Invite members to group' },
  { key: 'group.remove_member',   label: 'Remove members from group' },
  { key: 'payout.set_order',      label: 'Propose payout order changes' },
  { key: 'payout.approve_order',  label: 'Approve payout order changes' },
  { key: 'payout.disburse',       label: 'Trigger payout disbursements' },
  { key: 'withdrawal.request',    label: 'Request group withdrawals' },
  { key: 'withdrawal.vote',       label: 'Vote on group withdrawals' },
];

/**
 * Compute a user's effective permissions, optionally within a group.
 * Union of:
 *  - the system platform role matching users.role
 *  - the system group role matching group_members.role (if groupId given)
 *  - any roles named in group_members.permissions (legacy array, e.g. 'approver')
 *  - custom role assignments in user_roles (platform-wide + this group)
 * '*' in the result means every permission.
 */
async function getEffectivePermissions(userId, groupId = null) {
  const result = await query(
    `
    WITH me AS (SELECT role FROM users WHERE id = $1),
    gm AS (
      SELECT role, permissions FROM group_members
      WHERE group_id = $2 AND user_id = $1 AND status = 'active'
    ),
    my_roles AS (
      -- platform system role
      SELECT r.id FROM roles r, me
        WHERE r.scope = 'platform' AND r.name = me.role
      UNION
      -- group system role
      SELECT r.id FROM roles r, gm
        WHERE $2::uuid IS NOT NULL AND r.scope = 'group' AND r.name = gm.role
      UNION
      -- legacy permissions array entries treated as group role names
      SELECT r.id FROM roles r, gm
        WHERE $2::uuid IS NOT NULL AND r.scope = 'group' AND r.name = ANY(gm.permissions)
      UNION
      -- custom assignments
      SELECT ur.role_id FROM user_roles ur
        WHERE ur.user_id = $1 AND (ur.group_id IS NULL OR ur.group_id = $2)
    )
    SELECT DISTINCT rp.permission
    FROM role_permissions rp JOIN my_roles mr ON mr.id = rp.role_id
    `,
    [userId, groupId]
  );
  return result.rows.map(r => r.permission);
}

const hasPermission = (perms, needed) => perms.includes('*') || perms.includes(needed);

module.exports = { PERMISSIONS_CATALOG, getEffectivePermissions, hasPermission };
