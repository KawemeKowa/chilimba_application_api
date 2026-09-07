/**
 * Wallet lookup helpers.
 *
 * `exec` is any querier — the pool's `query` or a transaction client's
 * `client.query.bind(client)` — so these work inside and outside transactions.
 *
 * Use these instead of hand-written upserts. The old
 * `ON CONFLICT (owner_id, type, group_id)` pattern silently created duplicate
 * personal wallets, because group_id IS NULL and Postgres treats NULLs as
 * distinct in a unique index (see migration 014).
 */

/**
 * The user's single personal wallet, creating it if it somehow doesn't exist.
 * Pass `forUpdate` when the caller is about to change the balance, so the row
 * is locked for the rest of the transaction.
 */
async function getOrCreatePersonalWallet(exec, userId, { forUpdate = false } = {}) {
  const select = `SELECT * FROM wallets
                  WHERE owner_id = $1 AND type = 'personal' AND group_id IS NULL
                  LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`;

  const existing = await exec(select, [userId]);
  if (existing.rows.length) return existing.rows[0];

  // DO NOTHING rather than DO UPDATE: a concurrent request may have just
  // created it, in which case we simply re-read below.
  await exec(
    `INSERT INTO wallets (owner_id, type, currency)
     VALUES ($1, 'personal', 'ZMW')
     ON CONFLICT (owner_id) WHERE type = 'personal' AND group_id IS NULL
     DO NOTHING`,
    [userId]
  );

  const created = await exec(select, [userId]);
  return created.rows[0];
}

/**
 * The user's wallet for one group, creating it if needed. Currency follows the
 * group's own setting.
 */
async function getOrCreateGroupWallet(exec, userId, groupId, { forUpdate = false } = {}) {
  const select = `SELECT * FROM wallets
                  WHERE owner_id = $1 AND type = 'group' AND group_id = $2
                  LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`;

  const existing = await exec(select, [userId, groupId]);
  if (existing.rows.length) return existing.rows[0];

  // group_id is NOT NULL here, so the original unique constraint works fine
  await exec(
    `INSERT INTO wallets (owner_id, type, currency, group_id)
     VALUES ($1, 'group', COALESCE((SELECT currency FROM groups WHERE id = $2), 'ZMW'), $2)
     ON CONFLICT (owner_id, type, group_id) DO NOTHING`,
    [userId, groupId]
  );

  const created = await exec(select, [userId, groupId]);
  return created.rows[0];
}

module.exports = { getOrCreatePersonalWallet, getOrCreateGroupWallet };
