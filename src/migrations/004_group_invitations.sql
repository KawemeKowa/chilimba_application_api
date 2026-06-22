-- ============================================================
-- GROUP EMAIL INVITATIONS
-- ============================================================

CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'declined', 'expired');

CREATE TABLE group_invitations (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  invited_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email        VARCHAR(255) NOT NULL,
  token        VARCHAR(64) UNIQUE NOT NULL,
  status       invitation_status NOT NULL DEFAULT 'pending',
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_group_invitations_token   ON group_invitations(token);
CREATE INDEX idx_group_invitations_group   ON group_invitations(group_id);
CREATE INDEX idx_group_invitations_email   ON group_invitations(email);
