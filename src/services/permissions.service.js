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
      -- platform system role (users.role is an enum — cast to text to compare
      -- against roles.name which is varchar)
      SELECT r.id FROM roles r, me
        WHERE r.scope = 'platform' AND r.name = me.role::text
      UNION
      -- group system role (group_members.role is an enum — cast to text)
      SELECT r.id FROM roles r, gm
        WHERE $2::uuid IS NOT NULL AND r.scope = 'group' AND r.name = gm.role::text
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

/**
 * User ids of a group's active members who hold a permission — via system
 * role, the legacy permissions array, or a custom role assignment. Pass
 * excludeUserId to leave one person out (the requester, the proposer).
 */
async function membersWithPermission(groupId, permission, excludeUserId = null) {
  const r = await query(
    `SELECT gm.user_id FROM group_members gm
     WHERE gm.group_id = $1 AND gm.status = 'active'
       AND ($2::uuid IS NULL OR gm.user_id <> $2)
       AND EXISTS (
         SELECT 1 FROM roles ro JOIN role_permissions rp ON rp.role_id = ro.id
         WHERE rp.permission IN ($3, '*')
           AND (
             (ro.scope = 'group' AND ro.name = gm.role::text)
             OR (ro.scope = 'group' AND ro.name = ANY(gm.permissions))
             OR ro.id IN (
               SELECT ur.role_id FROM user_roles ur
               WHERE ur.user_id = gm.user_id
                 AND (ur.group_id IS NULL OR ur.group_id = gm.group_id)
             )
           )
       )`,
    [groupId, excludeUserId, permission]
  );
  return r.rows.map(row => row.user_id);
}

module.exports = { PERMISSIONS_CATALOG, getEffectivePermissions, hasPermission, membersWithPermission };
