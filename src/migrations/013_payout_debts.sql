-- Tracks shortfalls when a payout is disbursed for less than expected_amount.
-- Created when admin approves a partial payout; resolved when outstanding debt is paid.
CREATE TABLE IF NOT EXISTS group_payout_debts (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id            UUID          NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  payout_schedule_id  UUID          NOT NULL REFERENCES payout_schedule(id),
  recipient_user_id   UUID          NOT NULL REFERENCES users(id),
  cycle_number        INT           NOT NULL,
  amount_owed         NUMERIC(15,2) NOT NULL,
  amount_paid         NUMERIC(15,2) NOT NULL DEFAULT 0,
  status              VARCHAR(20)   NOT NULL DEFAULT 'outstanding'
                        CHECK (status IN ('outstanding', 'paid')),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  paid_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payout_debts_group      ON group_payout_debts(group_id);
CREATE INDEX IF NOT EXISTS idx_payout_debts_recipient  ON group_payout_debts(recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_payout_debts_status     ON group_payout_debts(group_id, status);
