-- 007: Group-level permissions + payout order change approval workflow

-- Per-member permissions within a group. 'approver' allows changing the
-- payout schedule and triggering disbursements for the next recipient.
ALTER TABLE group_members
  ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}';

-- Group creators (owners) are approvers automatically
UPDATE group_members
  SET permissions = ARRAY['approver']
  WHERE role = 'owner' AND NOT ('approver' = ANY(permissions));

-- Proposed payout order changes awaiting approval
CREATE TABLE IF NOT EXISTS payout_order_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  proposed_by UUID NOT NULL REFERENCES users(id),
  new_order JSONB NOT NULL,                       -- [{"userId": "...", "payoutOrder": 1}, ...]
  status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  approvals_needed INT NOT NULL DEFAULT 0,
  approvals_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payout_proposals_group
  ON payout_order_proposals(group_id, status);

-- Votes on proposals
CREATE TABLE IF NOT EXISTS payout_order_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES payout_order_proposals(id) ON DELETE CASCADE,
  approver_id UUID NOT NULL REFERENCES users(id),
  action VARCHAR(10) NOT NULL,                    -- approved | rejected
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(proposal_id, approver_id)
);
