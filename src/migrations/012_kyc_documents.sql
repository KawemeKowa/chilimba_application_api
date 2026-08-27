-- 012: KYC identity documents. Users submit a national ID (NRC / passport /
-- driver's licence) with front + back images; an admin reviews and approves,
-- which activates the account. id_type / id_number / id_verified already exist.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS id_front_url         TEXT,
  ADD COLUMN IF NOT EXISTS id_back_url          TEXT,
  ADD COLUMN IF NOT EXISTS kyc_submitted_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT;
