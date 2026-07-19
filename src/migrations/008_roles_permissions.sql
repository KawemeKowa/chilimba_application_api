-- 008: Configurable roles & permissions module
-- Roles carry a set of permissions; users are assigned roles either
-- platform-wide (group_id NULL) or within a specific group.
-- System roles mirror the built-in users.role / group_members.role values,
-- so editing a system role's permissions changes what those built-ins can do.

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(50) NOT NULL,
  scope VARCHAR(10) NOT NULL CHECK (scope IN ('platform', 'group')),
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(name, scope)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission VARCHAR(80) NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,  -- NULL = platform-wide
  granted_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, role_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id, group_id);

-- ── Seed system roles ─────────────────────────────────────────────────────────
INSERT INTO roles (name, scope, description, is_system) VALUES
  ('super_admin', 'platform', 'Full platform access',                          TRUE),
  ('admin',       'platform', 'Platform administrator',                        TRUE),
  ('member',      'platform', 'Regular platform user',                         TRUE),
  ('owner',       'group',    'Group creator',                                 TRUE),
  ('admin',       'group',    'Group administrator',                           TRUE),
  ('member',      'group',    'Group member',                                  TRUE),
  ('approver',    'group',    'Can manage the payout order and disburse payouts', TRUE)
ON CONFLICT (name, scope) DO NOTHING;

-- ── Seed default permissions per system role ──────────────────────────────────
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.perm FROM roles r
JOIN LATERAL (VALUES
  ('super_admin', 'platform', '*'),

  ('admin', 'platform', 'users.manage'),
  ('admin', 'platform', 'groups.manage'),
  ('admin', 'platform', 'finance.view'),
  ('admin', 'platform', 'roles.manage'),
  ('admin', 'platform', 'payout.disburse'),

  ('member', 'platform', 'wallet.deposit'),

  ('owner', 'group', 'group.edit'),
  ('owner', 'group', 'group.invite'),
  ('owner', 'group', 'group.remove_member'),
  ('owner', 'group', 'payout.set_order'),
  ('owner', 'group', 'payout.approve_order'),
  ('owner', 'group', 'payout.disburse'),
  ('owner', 'group', 'withdrawal.request'),
  ('owner', 'group', 'withdrawal.vote'),

  ('admin', 'group', 'group.edit'),
  ('admin', 'group', 'group.invite'),
  ('admin', 'group', 'group.remove_member'),
  ('admin', 'group', 'withdrawal.request'),
  ('admin', 'group', 'withdrawal.vote'),

  ('member', 'group', 'withdrawal.request'),
  ('member', 'group', 'withdrawal.vote'),

  ('approver', 'group', 'payout.set_order'),
  ('approver', 'group', 'payout.approve_order'),
  ('approver', 'group', 'payout.disburse')
) AS p(role_name, role_scope, perm)
  ON p.role_name = r.name AND p.role_scope = r.scope
ON CONFLICT (role_id, permission) DO NOTHING;
