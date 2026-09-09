-- Groups now start life in a setup phase instead of being live immediately.
--
-- The new flow: create the group -> invite the members -> settle the payout
-- order -> admin activates. Contributions only start once it is active.
-- createGroup already inserts status 'inactive' and activateGroup flips it to
-- 'active', but group_status (001_schema.sql) never had the value, so every
-- create failed with 22P02 "invalid input value for enum group_status".
--
-- ALTER TYPE ... ADD VALUE is allowed inside a transaction on PostgreSQL 12+
-- provided the new label is not *used* in that same transaction. This file
-- only declares it, so it is safe under the migration runner's BEGIN/COMMIT.

ALTER TYPE group_status ADD VALUE IF NOT EXISTS 'inactive';

-- The column default stays 'active' deliberately: existing live groups are
-- untouched, and both callers (createGroup, seed) pass status explicitly.
