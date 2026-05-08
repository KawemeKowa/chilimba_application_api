-- ============================================================
-- CHILIMBA PLATFORM - DATABASE SCHEMA
-- PostgreSQL
-- ============================================================

-- EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================
CREATE TYPE user_role AS ENUM ('member', 'group_admin', 'admin', 'super_admin');
CREATE TYPE user_status AS ENUM ('pending_verification', 'active', 'suspended', 'banned');
CREATE TYPE id_type AS ENUM ('national_id', 'passport', 'drivers_license');

CREATE TYPE group_status AS ENUM ('active', 'paused', 'completed', 'dissolved');
CREATE TYPE group_member_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE group_member_status AS ENUM ('pending', 'active', 'removed', 'left');

CREATE TYPE contribution_status AS ENUM ('pending', 'paid', 'late', 'waived');
CREATE TYPE payout_status AS ENUM ('scheduled', 'processing', 'completed', 'failed', 'skipped');

CREATE TYPE withdrawal_status AS ENUM ('pending_approval', 'approved', 'rejected', 'processing', 'completed', 'cancelled');
CREATE TYPE approval_action AS ENUM ('approved', 'rejected');

CREATE TYPE committee_status AS ENUM ('active', 'closed', 'cancelled');

CREATE TYPE transaction_type AS ENUM (
  'contribution', 'payout', 'withdrawal', 'committee_contribution',
  'fee', 'refund', 'deposit', 'transfer'
);
CREATE TYPE transaction_status AS ENUM ('pending', 'completed', 'failed', 'reversed');
CREATE TYPE wallet_type AS ENUM ('personal', 'group', 'committee');

CREATE TYPE notification_type AS ENUM (
  'contribution_reminder', 'contribution_received', 'payout_scheduled',
  'payout_disbursed', 'withdrawal_initiated', 'withdrawal_approved',
  'withdrawal_rejected', 'group_invite', 'group_joined', 'new_message',
  'committee_created', 'committee_contribution', 'system'
);

CREATE TYPE audit_action AS ENUM (
  'user_created', 'user_updated', 'user_suspended', 'user_banned',
  'group_created', 'group_dissolved', 'member_added', 'member_removed',
  'contribution_recorded', 'payout_disbursed', 'withdrawal_approved',
  'withdrawal_rejected', 'settings_changed', 'fee_updated', 'admin_login'
);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  first_name        VARCHAR(100) NOT NULL,
  last_name         VARCHAR(100) NOT NULL,
  email             VARCHAR(255) UNIQUE NOT NULL,
  phone             VARCHAR(20) UNIQUE NOT NULL,
  password_hash     TEXT NOT NULL,
  role              user_role NOT NULL DEFAULT 'member',
  status            user_status NOT NULL DEFAULT 'pending_verification',
  date_of_birth     DATE,
  id_type           id_type,
  id_number         VARCHAR(50),
  id_verified       BOOLEAN DEFAULT FALSE,
  profile_photo_url TEXT,
  last_login_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT age_check CHECK (
    date_of_birth IS NULL OR
    DATE_PART('year', AGE(date_of_birth)) >= 16
  )
);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_status ON users(status);

-- ============================================================
-- REFRESH TOKENS
-- ============================================================
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- ============================================================
-- GROUPS
-- ============================================================
CREATE TABLE groups (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                      VARCHAR(150) NOT NULL,
  description               TEXT,
  slug                      VARCHAR(100) UNIQUE NOT NULL,
  status                    group_status NOT NULL DEFAULT 'active',
  monthly_amount            NUMERIC(15,2) NOT NULL,
  currency                  CHAR(3) NOT NULL DEFAULT 'ZMW',
  max_members               INTEGER NOT NULL DEFAULT 12,
  current_cycle             INTEGER NOT NULL DEFAULT 1,
  contribution_day          INTEGER NOT NULL DEFAULT 1 CHECK (contribution_day BETWEEN 1 AND 28),
  payout_day                INTEGER NOT NULL DEFAULT 25 CHECK (payout_day BETWEEN 1 AND 28),
  min_approvals_withdrawal  INTEGER NOT NULL DEFAULT 2,
  allow_late_contributions  BOOLEAN DEFAULT TRUE,
  late_fee_amount           NUMERIC(15,2) DEFAULT 0,
  invite_code               VARCHAR(10) UNIQUE NOT NULL,
  invite_expires_at         TIMESTAMPTZ,
  created_by                UUID NOT NULL REFERENCES users(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_groups_slug ON groups(slug);
CREATE INDEX idx_groups_invite ON groups(invite_code);
CREATE INDEX idx_groups_status ON groups(status);

-- ============================================================
-- GROUP MEMBERS
-- ============================================================
CREATE TABLE group_members (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id      UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          group_member_role NOT NULL DEFAULT 'member',
  status        group_member_status NOT NULL DEFAULT 'pending',
  payout_order  INTEGER, -- assigned position in rotation
  joined_at     TIMESTAMPTZ,
  removed_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, user_id),
  UNIQUE (group_id, payout_order)
);
CREATE INDEX idx_group_members_group ON group_members(group_id);
CREATE INDEX idx_group_members_user ON group_members(user_id);

-- ============================================================
-- PAYOUT SCHEDULE  (one row per member per cycle)
-- ============================================================
CREATE TABLE payout_schedule (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  cycle_number    INTEGER NOT NULL,
  payout_order    INTEGER NOT NULL,
  scheduled_date  DATE NOT NULL,
  expected_amount NUMERIC(15,2) NOT NULL,
  status          payout_status NOT NULL DEFAULT 'scheduled',
  actual_amount   NUMERIC(15,2),
  paid_at         TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, cycle_number, payout_order)
);
CREATE INDEX idx_payout_schedule_group ON payout_schedule(group_id);
CREATE INDEX idx_payout_schedule_user ON payout_schedule(user_id);
CREATE INDEX idx_payout_schedule_date ON payout_schedule(scheduled_date);

-- ============================================================
-- CONTRIBUTIONS  (one row per member per monthly round)
-- ============================================================
CREATE TABLE contributions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id          UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id),
  cycle_number      INTEGER NOT NULL,
  round_number      INTEGER NOT NULL,  -- month within cycle
  amount_due        NUMERIC(15,2) NOT NULL,
  amount_paid       NUMERIC(15,2) NOT NULL DEFAULT 0,
  status            contribution_status NOT NULL DEFAULT 'pending',
  due_date          DATE NOT NULL,
  paid_at           TIMESTAMPTZ,
  late_fee_charged  NUMERIC(15,2) DEFAULT 0,
  reference         VARCHAR(100) UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, user_id, cycle_number, round_number)
);
CREATE INDEX idx_contributions_group ON contributions(group_id);
CREATE INDEX idx_contributions_user ON contributions(user_id);
CREATE INDEX idx_contributions_due_date ON contributions(due_date);
CREATE INDEX idx_contributions_status ON contributions(status);

-- ============================================================
-- WALLETS
-- ============================================================
CREATE TABLE wallets (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         wallet_type NOT NULL DEFAULT 'personal',
  group_id     UUID REFERENCES groups(id) ON DELETE CASCADE,
  balance      NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  currency     CHAR(3) NOT NULL DEFAULT 'ZMW',
  is_frozen    BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, type, group_id)
);
CREATE INDEX idx_wallets_owner ON wallets(owner_id);
CREATE INDEX idx_wallets_group ON wallets(group_id);

-- ============================================================
-- TRANSACTIONS  (immutable ledger)
-- ============================================================
CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id       UUID NOT NULL REFERENCES wallets(id),
  type            transaction_type NOT NULL,
  direction       CHAR(6) NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount          NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  balance_before  NUMERIC(15,2) NOT NULL,
  balance_after   NUMERIC(15,2) NOT NULL,
  status          transaction_status NOT NULL DEFAULT 'pending',
  reference_id    UUID,  -- contribution_id, payout_id, withdrawal_id
  reference_type  VARCHAR(50),
  description     TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_transactions_wallet ON transactions(wallet_id);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_created ON transactions(created_at);
CREATE INDEX idx_transactions_reference ON transactions(reference_id);

-- ============================================================
-- WITHDRAWAL REQUESTS
-- ============================================================
CREATE TABLE withdrawal_requests (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id          UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  requested_by      UUID NOT NULL REFERENCES users(id),
  amount            NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reason            TEXT NOT NULL,
  status            withdrawal_status NOT NULL DEFAULT 'pending_approval',
  approvals_needed  INTEGER NOT NULL,
  approvals_count   INTEGER NOT NULL DEFAULT 0,
  rejections_count  INTEGER NOT NULL DEFAULT 0,
  expires_at        TIMESTAMPTZ NOT NULL,
  processed_at      TIMESTAMPTZ,
  processed_by      UUID REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_withdrawals_group ON withdrawal_requests(group_id);
CREATE INDEX idx_withdrawals_status ON withdrawal_requests(status);

-- ============================================================
-- WITHDRAWAL APPROVALS  (multi-member voting)
-- ============================================================
CREATE TABLE withdrawal_approvals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  withdrawal_id   UUID NOT NULL REFERENCES withdrawal_requests(id) ON DELETE CASCADE,
  member_id       UUID NOT NULL REFERENCES users(id),
  action          approval_action NOT NULL,
  comment         TEXT,
  voted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (withdrawal_id, member_id)
);
CREATE INDEX idx_approvals_withdrawal ON withdrawal_approvals(withdrawal_id);

-- ============================================================
-- COMMITTEE POOLS  (crowdfunding campaigns)
-- ============================================================
CREATE TABLE committee_pools (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id       UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by     UUID NOT NULL REFERENCES users(id),
  title          VARCHAR(200) NOT NULL,
  description    TEXT NOT NULL,
  category       VARCHAR(50) NOT NULL, -- funeral, wedding, emergency, other
  target_amount  NUMERIC(15,2),
  raised_amount  NUMERIC(15,2) NOT NULL DEFAULT 0,
  status         committee_status NOT NULL DEFAULT 'active',
  closes_at      TIMESTAMPTZ,
  beneficiary    VARCHAR(200),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_committee_group ON committee_pools(group_id);
CREATE INDEX idx_committee_status ON committee_pools(status);

-- ============================================================
-- COMMITTEE CONTRIBUTIONS
-- ============================================================
CREATE TABLE committee_contributions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pool_id      UUID NOT NULL REFERENCES committee_pools(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id),
  amount       NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  message      TEXT,
  is_anonymous BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_committee_contrib_pool ON committee_contributions(pool_id);
CREATE INDEX idx_committee_contrib_user ON committee_contributions(user_id);

-- ============================================================
-- GROUP MESSAGES
-- ============================================================
CREATE TABLE group_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  content     TEXT NOT NULL,
  is_pinned   BOOLEAN DEFAULT FALSE,
  is_deleted  BOOLEAN DEFAULT FALSE,
  parent_id   UUID REFERENCES group_messages(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_messages_group ON group_messages(group_id);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        notification_type NOT NULL,
  title       VARCHAR(200) NOT NULL,
  body        TEXT NOT NULL,
  data        JSONB DEFAULT '{}',
  is_read     BOOLEAN DEFAULT FALSE,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_read);

-- ============================================================
-- FEES CONFIG
-- ============================================================
CREATE TABLE fees_config (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           VARCHAR(100) NOT NULL,
  fee_type       VARCHAR(50) NOT NULL, -- percentage | flat
  value          NUMERIC(8,4) NOT NULL,
  applies_to     VARCHAR(50) NOT NULL, -- contribution | payout | withdrawal | committee
  is_active      BOOLEAN DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO fees_config (name, fee_type, value, applies_to)
VALUES
  ('Contribution Fee', 'percentage', 0.5, 'contribution'),
  ('Payout Fee', 'percentage', 1.0, 'payout'),
  ('Withdrawal Fee', 'flat', 5.00, 'withdrawal');

-- ============================================================
-- PLATFORM SETTINGS
-- ============================================================
CREATE TABLE platform_settings (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO platform_settings (key, value, description) VALUES
  ('min_contribution_amount', '50', 'Minimum monthly contribution in ZMW'),
  ('max_members_per_group', '50', 'Maximum members per Chilimba group'),
  ('withdrawal_expiry_hours', '72', 'Hours before withdrawal request expires'),
  ('platform_name', 'Chilimba', 'Platform display name'),
  ('maintenance_mode', 'false', 'Toggle platform maintenance mode'),
  ('max_groups_per_user', '5', 'Max groups a user can join'),
  ('kyc_required', 'true', 'Whether KYC verification is required');

-- ============================================================
-- AUDIT LOGS
-- ============================================================
CREATE TABLE audit_logs (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id     UUID REFERENCES users(id),
  actor_email  VARCHAR(255),
  action       audit_action NOT NULL,
  entity_type  VARCHAR(50),
  entity_id    UUID,
  changes      JSONB DEFAULT '{}',
  ip_address   INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id);
CREATE INDEX idx_audit_action ON audit_logs(action);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

-- ============================================================
-- TRIGGER: updated_at auto-refresh
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'users','groups','group_members','payout_schedule','contributions',
    'wallets','withdrawal_requests','committee_pools','group_messages',
    'fees_config'
  ]) LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION update_updated_at()', t, t
    );
  END LOOP;
END $$;

-- ============================================================
-- VIEWS for analytics
-- ============================================================

-- Group financial summary
CREATE VIEW v_group_summary AS
SELECT
  g.id,
  g.name,
  g.status,
  g.monthly_amount,
  g.currency,
  g.current_cycle,
  COUNT(DISTINCT gm.user_id) FILTER (WHERE gm.status = 'active') AS active_members,
  COALESCE(SUM(c.amount_paid), 0) AS total_collected,
  COALESCE(SUM(c.amount_due) - SUM(c.amount_paid), 0) AS total_outstanding,
  COUNT(c.id) FILTER (WHERE c.status = 'pending' AND c.due_date < NOW()) AS overdue_contributions
FROM groups g
LEFT JOIN group_members gm ON gm.group_id = g.id
LEFT JOIN contributions c ON c.group_id = g.id
GROUP BY g.id;

-- Platform daily stats
CREATE VIEW v_platform_daily_stats AS
SELECT
  DATE(created_at) AS stat_date,
  COUNT(*) FILTER (WHERE type = 'contribution' AND status = 'completed') AS contributions_count,
  SUM(amount) FILTER (WHERE type = 'contribution' AND status = 'completed') AS contributions_volume,
  COUNT(*) FILTER (WHERE type = 'payout' AND status = 'completed') AS payouts_count,
  SUM(amount) FILTER (WHERE type = 'payout' AND status = 'completed') AS payouts_volume,
  COUNT(*) FILTER (WHERE type = 'fee' AND status = 'completed') AS fees_count,
  SUM(amount) FILTER (WHERE type = 'fee' AND status = 'completed') AS fee_revenue
FROM transactions
GROUP BY DATE(created_at);

-- Member contribution compliance
CREATE VIEW v_member_compliance AS
SELECT
  gm.group_id,
  gm.user_id,
  u.first_name || ' ' || u.last_name AS full_name,
  COUNT(c.id) AS total_contributions_due,
  COUNT(c.id) FILTER (WHERE c.status = 'paid') AS paid_count,
  COUNT(c.id) FILTER (WHERE c.status = 'late') AS late_count,
  COUNT(c.id) FILTER (WHERE c.status = 'pending' AND c.due_date < NOW()) AS overdue_count,
  ROUND(
    COUNT(c.id) FILTER (WHERE c.status = 'paid')::NUMERIC /
    NULLIF(COUNT(c.id), 0) * 100, 2
  ) AS compliance_rate
FROM group_members gm
JOIN users u ON u.id = gm.user_id
LEFT JOIN contributions c ON c.group_id = gm.group_id AND c.user_id = gm.user_id
WHERE gm.status = 'active'
GROUP BY gm.group_id, gm.user_id, u.first_name, u.last_name;
