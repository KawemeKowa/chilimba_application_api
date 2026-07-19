const { query } = require('../../config/db');
const { PERMISSIONS_CATALOG, getEffectivePermissions } = require('../../services/permissions.service');
const { notify } = require('../../services/notification.service');

// ─── GET /api/roles ───────────────────────────────────────────────────────────
// All roles with their permissions, plus the permission catalog
const listRoles = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT r.id, r.name, r.scope, r.description, r.is_system AS "isSystem",
              COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
       GROUP BY r.id
       ORDER BY r.scope, r.is_system DESC, r.name`
    );
    res.json({ success: true, data: { roles: result.rows, catalog: PERMISSIONS_CATALOG } });
  } catch (err) { next(err); }
};

// ─── POST /api/roles ──────────────────────────────────────────────────────────
// Create a custom role. Body: { name, scope, description?, permissions: [] }
const createRole = async (req, res, next) => {
  try {
    const { name, scope, description, permissions = [] } = req.body;

    const valid = new Set(PERMISSIONS_CATALOG.map(p => p.key));
    if (!permissions.every(p => valid.has(p))) {
      return res.status(400).json({ success: false, message: 'Unknown permission in list.' });
    }

    const existing = await query(`SELECT id FROM roles WHERE name = $1 AND scope = $2`, [name, scope]);
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: `A ${scope} role named "${name}" already exists.` });
    }

    const roleRes = await query(
      `INSERT INTO roles (name, scope, description) VALUES ($1, $2, $3) RETURNING id`,
      [name, scope, description || null]
    );
    for (const perm of permissions) {
      await query(
        `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roleRes.rows[0].id, perm]
      );
    }
    res.status(201).json({ success: true, message: 'Role created.', data: { id: roleRes.rows[0].id } });
  } catch (err) { next(err); }
};

// ─── PATCH /api/roles/:roleId ─────────────────────────────────────────────────
// Update description and/or replace the permission set.
// The platform super_admin role is locked.
const updateRole = async (req, res, next) => {
  try {
    const { roleId } = req.params;
    const { description, permissions } = req.body;

    const roleRes = await query(`SELECT * FROM roles WHERE id = $1`, [roleId]);
    if (!roleRes.rows.length) {
      return res.status(404).json({ success: false, message: 'Role not found.' });
    }
    const role = roleRes.rows[0];
    if (role.name === 'super_admin' && role.scope === 'platform') {
      return res.status(400).json({ success: false, message: 'The super_admin role cannot be modified.' });
    }

    if (description !== undefined) {
      await query(`UPDATE roles SET description = $1 WHERE id = $2`, [description, roleId]);
    }

    if (Array.isArray(permissions)) {
      const valid = new Set(PERMISSIONS_CATALOG.map(p => p.key));
      if (!permissions.every(p => valid.has(p))) {
        return res.status(400).json({ success: false, message: 'Unknown permission in list.' });
      }
      await query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
      for (const perm of permissions) {
        await query(
          `INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [roleId, perm]
        );
      }
    }

    res.json({ success: true, message: 'Role updated.' });
  } catch (err) { next(err); }
};

// ─── DELETE /api/roles/:roleId ────────────────────────────────────────────────
const deleteRole = async (req, res, next) => {
  try {
    const roleRes = await query(`SELECT is_system FROM roles WHERE id = $1`, [req.params.roleId]);
    if (!roleRes.rows.length) {
      return res.status(404).json({ success: false, message: 'Role not found.' });
    }
    if (roleRes.rows[0].is_system) {
      return res.status(400).json({ success: false, message: 'System roles cannot be deleted.' });
    }
    await query(`DELETE FROM roles WHERE id = $1`, [req.params.roleId]);
    res.json({ success: true, message: 'Role deleted.' });
  } catch (err) { next(err); }
};

// ─── GET /api/roles/assignments ───────────────────────────────────────────────
const listAssignments = async (req, res, next) => {
  try {
    const result = await query(
      `SELECT ur.id, ur.user_id AS "userId", ur.role_id AS "roleId", ur.group_id AS "groupId",
              ur.created_at AS "createdAt",
              u.first_name || ' ' || u.last_name AS "userName", u.email AS "userEmail",
              r.name AS "roleName", r.scope AS "roleScope",
              g.name AS "groupName"
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN groups g ON g.id = ur.group_id
       ORDER BY ur.created_at DESC`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
};

// ─── POST /api/roles/:roleId/assign ───────────────────────────────────────────
// Body: { email, groupId? }  (groupId required for group-scoped roles)
const assignRole = async (req, res, next) => {
  try {
    const { roleId } = req.params;
    const { email, groupId } = req.body;

    const roleRes = await query(`SELECT * FROM roles WHERE id = $1`, [roleId]);
    if (!roleRes.rows.length) {
      return res.status(404).json({ success: false, message: 'Role not found.' });
    }
    const role = roleRes.rows[0];

    if (role.scope === 'group' && !groupId) {
      return res.status(400).json({ success: false, message: 'A group is required for group-scoped roles.' });
    }
    if (role.scope === 'platform' && groupId) {
      return res.status(400).json({ success: false, message: 'Platform roles cannot be scoped to a group.' });
    }

    const userRes = await query(`SELECT id, first_name FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
    if (!userRes.rows.length) {
      return res.status(404).json({ success: false, message: 'No user found with that email.' });
    }
    const targetUser = userRes.rows[0];

    if (role.scope === 'group') {
      const gm = await query(
        `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
        [groupId, targetUser.id]
      );
      if (!gm.rows.length) {
        return res.status(400).json({ success: false, message: 'That user is not an active member of the selected group.' });
      }
    }

    await query(
      `INSERT INTO user_roles (user_id, role_id, group_id, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, role_id, group_id) DO NOTHING`,
      [targetUser.id, roleId, groupId || null, req.user.id]
    );

    notify(targetUser.id, 'system', 'Role Assigned',
      `You have been given the "${role.name}" role${role.scope === 'group' ? ' in one of your groups' : ''}.`,
      { roleId, groupId: groupId || null }).catch(() => {});

    res.status(201).json({ success: true, message: `Role "${role.name}" assigned to ${targetUser.first_name}.` });
  } catch (err) { next(err); }
};

// ─── DELETE /api/roles/assignments/:assignmentId ──────────────────────────────
const revokeAssignment = async (req, res, next) => {
  try {
    const result = await query(`DELETE FROM user_roles WHERE id = $1 RETURNING user_id`, [req.params.assignmentId]);
    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Assignment not found.' });
    }
    res.json({ success: true, message: 'Role assignment revoked.' });
  } catch (err) { next(err); }
};

// ─── GET /api/roles/my-permissions?groupId= ───────────────────────────────────
// Effective permissions for the logged-in user (used by the frontend for gating)
const myPermissions = async (req, res, next) => {
  try {
    const perms = await getEffectivePermissions(req.user.id, req.query.groupId || null);
    res.json({ success: true, data: perms });
  } catch (err) { next(err); }
};

module.exports = {
  listRoles, createRole, updateRole, deleteRole,
  listAssignments, assignRole, revokeAssignment,
  myPermissions,
};
