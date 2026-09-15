-- Requesting a second reset email used to kill the link in the first one.
--
-- forgotPassword marked every outstanding row used_at = NOW() before issuing a
-- new token, so a member who pressed "Send reset link" again — usually because
-- the first attempt had just failed — invalidated the email that was, at that
-- moment, landing in their inbox. They then clicked it and got "Invalid or
-- expired reset link", which sent them back to request another one. The loop
-- is self-sustaining and nothing in the message explains it.
--
-- Two changes make that diagnosable. The controller now keeps the newest few
-- links alive instead of all-but-one, and retiring a link no longer borrows
-- used_at: that column means "a password was actually reset with this token"
-- and nothing else. Superseding gets its own column so reset-password can tell
-- the two apart and say which one happened.

ALTER TABLE password_resets
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- The lookup filters on token_hash first (already UNIQUE), so this is only for
-- the "newest N still-live links for this user" sweep in forgotPassword.
CREATE INDEX IF NOT EXISTS idx_password_resets_user_live
  ON password_resets (user_id, created_at DESC)
  WHERE used_at IS NULL AND superseded_at IS NULL;
