-- 011: Allow contribution/payout deadline days up to 31 (some months have
-- 29–31 days). Date computation clamps day 29/30/31 to the last valid day of
-- short months. Previously capped at 28.

ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_contribution_day_check;
ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_payout_day_check;

ALTER TABLE groups
  ADD CONSTRAINT groups_contribution_day_check CHECK (contribution_day BETWEEN 1 AND 31),
  ADD CONSTRAINT groups_payout_day_check       CHECK (payout_day BETWEEN 1 AND 31);
