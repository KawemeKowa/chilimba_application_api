-- Withdrawal votes belong to the group's approvers, not to every member.
--
-- 008 handed withdrawal.vote to the system 'member' role, so any member could
-- approve another member's withdrawal and the "approver" flag the admin sets
-- on people meant nothing for withdrawals. The flag now carries the vote:
-- 'approver' gains withdrawal.vote, 'member' loses it. Owner and group admin
-- keep theirs — the owner's approver status can't be revoked anyway, and a
-- group admin is management. Custom roles (e.g. the seeded treasurer) are
-- untouched; they name their own permissions.

DELETE FROM role_permissions
 WHERE permission = 'withdrawal.vote'
   AND role_id = (SELECT id FROM roles WHERE scope = 'group' AND name = 'member');

INSERT INTO role_permissions (role_id, permission)
SELECT id, 'withdrawal.vote' FROM roles WHERE scope = 'group' AND name = 'approver'
ON CONFLICT DO NOTHING;

UPDATE roles
   SET description = 'Can manage the payout order, disburse payouts and vote on withdrawals'
 WHERE scope = 'group' AND name = 'approver';
