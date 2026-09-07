-- Payment auditability and reconciliation.
--
-- Money can leave a customer's phone and never reach the platform: if the
-- Lipila webhook is missed (callback URL unset, network blip, deploy restart),
-- the transaction sits 'pending' forever and the wallet is never credited.
-- Nothing swept those up, and nothing recorded *why* a transaction ended in the
-- state it did.

-- ── 1. Reconciliation state on each Lipila transaction ──────────────────────
ALTER TABLE lipila_transactions
  ADD COLUMN IF NOT EXISTS reconciled_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciliation_source  VARCHAR(20),   -- webhook|sync|sweep|admin
  ADD COLUMN IF NOT EXISTS discrepancy            TEXT,          -- set when reported != expected
  ADD COLUMN IF NOT EXISTS check_attempts         INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_checked_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS needs_review           BOOLEAN NOT NULL DEFAULT FALSE;

-- The sweep looks for old pending rows; this index keeps that cheap.
CREATE INDEX IF NOT EXISTS idx_lipila_txn_pending_sweep
  ON lipila_transactions (status, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_lipila_txn_needs_review
  ON lipila_transactions (needs_review)
  WHERE needs_review = TRUE;

-- ── 2. Append-only event log for every payment state change ─────────────────
-- Deliberately separate from audit_logs, whose `action` is a fixed enum and
-- whose shape doesn't carry amounts. This is the money trail: every transition,
-- who or what caused it, and what the provider actually reported.
CREATE TABLE IF NOT EXISTS payment_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lipila_transaction_id UUID REFERENCES lipila_transactions(id) ON DELETE SET NULL,
  reference_id          VARCHAR(64) NOT NULL,
  event                 VARCHAR(40) NOT NULL,
    -- initiated | status_reported | credited | duplicate_ignored
    -- | discrepancy | reversed | manual_resolve | check_failed
  source                VARCHAR(20) NOT NULL,   -- api|webhook|sync|sweep|admin
  previous_status       VARCHAR(20),
  new_status            VARCHAR(20),
  expected_amount       NUMERIC(15,2),
  reported_amount       NUMERIC(15,2),
  wallet_id             UUID REFERENCES wallets(id) ON DELETE SET NULL,
  user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_id              UUID REFERENCES users(id) ON DELETE SET NULL,  -- admin, when manual
  detail                TEXT,
  payload               JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_reference ON payment_events(reference_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_txn       ON payment_events(lipila_transaction_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_created   ON payment_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_event     ON payment_events(event);
