-- 010: Group constitution — the rules captured at group creation that govern
-- how the group operates (financial rules, payout schedule mode, contribution
-- threshold, payout approval mode, and locks that take effect after the first
-- payout).

ALTER TABLE groups
  -- Financial rules
  ADD COLUMN IF NOT EXISTS grace_period_days INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS late_fee_type VARCHAR(12) NOT NULL DEFAULT 'none',   -- none | fixed | percentage
  ADD COLUMN IF NOT EXISTS late_fee_value NUMERIC(15,2) NOT NULL DEFAULT 0,
  -- Payout schedule
  ADD COLUMN IF NOT EXISTS payout_order_mode VARCHAR(16) NOT NULL DEFAULT 'fixed', -- fixed | random | admin_assigned
  -- Contribution requirement before a payout can occur (percent of expected pool)
  ADD COLUMN IF NOT EXISTS contribution_threshold_percent INTEGER NOT NULL DEFAULT 100
    CHECK (contribution_threshold_percent BETWEEN 1 AND 100),
  -- Payout approval
  ADD COLUMN IF NOT EXISTS payout_approval_mode VARCHAR(12) NOT NULL DEFAULT 'majority', -- none | majority
  ADD COLUMN IF NOT EXISTS payout_approvals_required INTEGER NOT NULL DEFAULT 0, -- 0 = auto (majority of active members)
  -- Locks that engage after the first payout
  ADD COLUMN IF NOT EXISTS schedule_locked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS members_locked  BOOLEAN NOT NULL DEFAULT FALSE;

-- Fold the legacy flat late_fee_amount into the new structured fields
UPDATE groups
  SET late_fee_type = 'fixed', late_fee_value = late_fee_amount
  WHERE late_fee_amount > 0 AND late_fee_type = 'none';

-- Per-payout approval votes (majority-vote gate on a scheduled payout).
-- Distinct from withdrawal_approvals and payout_order_approvals.
CREATE TABLE IF NOT EXISTS payout_approvals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_schedule_id UUID NOT NULL REFERENCES payout_schedule(id) ON DELETE CASCADE,
  approver_id        UUID NOT NULL REFERENCES users(id),
  action             VARCHAR(10) NOT NULL CHECK (action IN ('approved', 'rejected')),
  comment            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payout_schedule_id, approver_id)
);
CREATE INDEX IF NOT EXISTS idx_payout_approvals_schedule ON payout_approvals(payout_schedule_id);
