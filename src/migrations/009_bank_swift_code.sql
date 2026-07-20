-- 009: SWIFT/BIC code is required by Lipila's bank disbursement endpoint
ALTER TABLE user_payment_methods
  ADD COLUMN IF NOT EXISTS swift_code VARCHAR(20);
