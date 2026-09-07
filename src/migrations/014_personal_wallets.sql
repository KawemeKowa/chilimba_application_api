-- Personal wallets: exactly one per user, and it always exists.
--
-- UNIQUE (owner_id, type, group_id) never actually constrained personal
-- wallets: group_id IS NULL there, and Postgres treats NULLs as distinct in a
-- unique index. So every `ON CONFLICT (owner_id, type, group_id) DO UPDATE`
-- upsert inserted a brand-new row instead of updating, scattering payout
-- credits across duplicate wallets while the UI read whichever came first.
--
-- Nothing created a personal wallet at registration either, so most users had
-- none at all — which is why topping one up appeared to do nothing.

-- ── 1. Merge duplicate personal wallets into the oldest one per user ─────────
DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT w.id AS dupe_id, w.balance AS dupe_balance, k.keep_id
    FROM wallets w
    JOIN (
      SELECT DISTINCT ON (owner_id) owner_id, id AS keep_id
      FROM wallets
      WHERE type = 'personal' AND group_id IS NULL
      ORDER BY owner_id, created_at, id
    ) k ON k.owner_id = w.owner_id
    WHERE w.type = 'personal'
      AND w.group_id IS NULL
      AND w.id <> k.keep_id
  LOOP
    -- Move the ledger across before the row disappears
    UPDATE transactions        SET wallet_id = dup.keep_id WHERE wallet_id = dup.dupe_id;
    UPDATE lipila_transactions SET wallet_id = dup.keep_id WHERE wallet_id = dup.dupe_id;
    UPDATE wallets SET balance = balance + dup.dupe_balance WHERE id = dup.keep_id;
    DELETE FROM wallets WHERE id = dup.dupe_id;
  END LOOP;
END $$;

-- ── 2. Enforce one personal wallet per user from here on ────────────────────
-- Partial index, because the NULL group_id is exactly what defeated the
-- original table-level constraint.
CREATE UNIQUE INDEX IF NOT EXISTS wallets_one_personal_per_owner
  ON wallets (owner_id)
  WHERE type = 'personal' AND group_id IS NULL;

-- ── 3. Give every existing user the personal wallet they should have had ────
INSERT INTO wallets (owner_id, type, currency)
SELECT u.id, 'personal', 'ZMW'
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM wallets w
  WHERE w.owner_id = u.id AND w.type = 'personal' AND w.group_id IS NULL
);
