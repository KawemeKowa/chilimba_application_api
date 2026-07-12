-- Lipila payment transactions ledger (one row per API call to Lipila)
CREATE TABLE IF NOT EXISTS lipila_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_id    VARCHAR(64) UNIQUE NOT NULL,   -- our ID sent to Lipila as referenceId
  lipila_id       VARCHAR(100),                  -- Lipila's identifier from response/webhook
  type            VARCHAR(20) NOT NULL,           -- 'collection' | 'disbursement'
  status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending'|'successful'|'failed'
  amount          NUMERIC(15,2) NOT NULL,
  currency        VARCHAR(10) NOT NULL DEFAULT 'ZMW',
  account_number  VARCHAR(50),                   -- mobile number or bank account
  payment_type    VARCHAR(50),                   -- MTNMoney, AirtelMoney, ZamtelKwacha, Bank
  narration       TEXT,
  -- links back to our system
  wallet_id       UUID REFERENCES wallets(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  group_id        UUID REFERENCES groups(id) ON DELETE SET NULL,
  -- raw data
  webhook_received_at TIMESTAMPTZ,
  raw_webhook     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lipila_txn_reference   ON lipila_transactions(reference_id);
CREATE INDEX IF NOT EXISTS idx_lipila_txn_user        ON lipila_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_lipila_txn_status_type ON lipila_transactions(status, type);

-- User payment methods (mobile money + bank for disbursements)
CREATE TABLE IF NOT EXISTS user_payment_methods (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                VARCHAR(20) NOT NULL,    -- 'mobile_money' | 'bank'
  -- mobile money
  mobile_number       VARCHAR(20),
  mobile_provider     VARCHAR(20),             -- 'mtn' | 'airtel' | 'zamtel'
  -- bank
  bank_name           VARCHAR(100),
  account_number      VARCHAR(50),
  account_name        VARCHAR(100),
  branch              VARCHAR(100),
  -- flags
  is_default          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, type)
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON user_payment_methods(user_id);
