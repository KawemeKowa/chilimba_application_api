require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME     || 'chilimba_db',
      user:     process.env.DB_USER     || 'chilimba_user',
      password: process.env.DB_PASSWORD || '',
    });

const q = (text, params) => pool.query(text, params);

// ─── Date helpers ─────────────────────────────────────────────────────────────
const iso = (d) => d.toISOString();
const isoDate = (d) => d.toISOString().split('T')[0];
function daysAgo(n)   { const d = new Date(); d.setDate(d.getDate() - n); return d; }
function daysAhead(n) { const d = new Date(); d.setDate(d.getDate() + n); return d; }
function monthsAhead(n, day = 25) { const d = new Date(); d.setMonth(d.getMonth() + n); d.setDate(day); return d; }

// ─── Test users ───────────────────────────────────────────────────────────────
const MEMBER_PW = 'Member@2025!';
const USERS = [
  { first_name: 'Super',    last_name: 'Admin',  email: 'superadmin@chilimba.app', phone: '+260971000001', password: 'Chilimba@2025!', role: 'super_admin', status: 'active',               id_verified: true,  dob: '1980-01-01' },
  { first_name: 'Platform', last_name: 'Admin',  email: 'admin@chilimba.app',      phone: '+260971000002', password: 'Admin@2025!',    role: 'admin',       status: 'active',               id_verified: true,  dob: '1985-06-15' },
  { first_name: 'Bwalya',   last_name: 'Mwale',  email: 'bwalya@example.com',      phone: '+260976543210', password: MEMBER_PW,        role: 'member',      status: 'active',               id_verified: true,  dob: '1992-03-14' },
  { first_name: 'Mwansa',   last_name: 'Chanda', email: 'mwansa@example.com',      phone: '+260977654321', password: MEMBER_PW,        role: 'member',      status: 'active',               id_verified: true,  dob: '1988-07-22' },
  { first_name: 'Chipo',    last_name: 'Banda',  email: 'chipo@example.com',       phone: '+260978765432', password: MEMBER_PW,        role: 'member',      status: 'active',               id_verified: true,  dob: '1995-11-05' },
  { first_name: 'Natasha',  last_name: 'Zulu',   email: 'natasha@example.com',     phone: '+260979000001', password: MEMBER_PW,        role: 'member',      status: 'active',               id_verified: true,  dob: '1990-09-19' },
  { first_name: 'Kabwe',    last_name: 'Tembo',  email: 'kabwe@example.com',       phone: '+260979000002', password: MEMBER_PW,        role: 'member',      status: 'active',               id_verified: true,  dob: '1993-02-08' },
  { first_name: 'Temba',    last_name: 'Sakala', email: 'temba@example.com',       phone: '+260979000003', password: MEMBER_PW,        role: 'member',      status: 'active',               id_verified: true,  dob: '1987-12-25' },
  { first_name: 'Mutale',   last_name: 'Phiri',  email: 'mutale@example.com',      phone: '+260979876543', password: MEMBER_PW,        role: 'member',      status: 'pending_verification', id_verified: false, dob: '2000-01-30' },
  { first_name: 'Suspended', last_name: 'User',  email: 'suspended@example.com',   phone: '+260979000009', password: MEMBER_PW,        role: 'member',      status: 'suspended',            id_verified: true,  dob: '1991-04-11' },
];

async function upsertUser(u) {
  const hash = await bcrypt.hash(u.password, 10);
  const { rows } = await q(
    `INSERT INTO users (first_name, last_name, email, phone, password_hash, role, status, id_verified, date_of_birth)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (email) DO UPDATE SET
       first_name=EXCLUDED.first_name, last_name=EXCLUDED.last_name, phone=EXCLUDED.phone,
       password_hash=EXCLUDED.password_hash, role=EXCLUDED.role, status=EXCLUDED.status,
       id_verified=EXCLUDED.id_verified, date_of_birth=EXCLUDED.date_of_birth
     RETURNING id`,
    [u.first_name, u.last_name, u.email, u.phone, hash, u.role, u.status, u.id_verified, u.dob]
  );
  return rows[0].id;
}

// Ensure a personal wallet exists; returns its id. (The UNIQUE(owner_id, type,
// group_id) constraint doesn't dedupe personal wallets because group_id is
// NULL and NULLs are distinct — so look it up explicitly.)
async function personalWallet(userId, balance = 0) {
  const existing = await q(
    `SELECT id FROM wallets WHERE owner_id=$1 AND type='personal' AND group_id IS NULL LIMIT 1`, [userId]);
  if (existing.rows.length) {
    await q(`UPDATE wallets SET balance=$2 WHERE id=$1`, [existing.rows[0].id, balance]);
    return existing.rows[0].id;
  }
  const { rows } = await q(
    `INSERT INTO wallets (owner_id, type, balance, currency) VALUES ($1,'personal',$2,'ZMW') RETURNING id`,
    [userId, balance]);
  return rows[0].id;
}

async function groupWallet(userId, groupId, balance = 0) {
  const { rows } = await q(
    `INSERT INTO wallets (owner_id, type, group_id, balance, currency)
     VALUES ($1,'group',$2,$3,'ZMW')
     ON CONFLICT (owner_id, type, group_id) DO UPDATE SET balance = EXCLUDED.balance
     RETURNING id`,
    [userId, groupId, balance]
  );
  return rows[0].id;
}

// Wipe a seeded group's scenario children so each run is deterministic
async function resetGroupChildren(groupId) {
  await q(`DELETE FROM payout_approvals WHERE payout_schedule_id IN (SELECT id FROM payout_schedule WHERE group_id=$1)`, [groupId]);
  await q(`DELETE FROM payout_schedule WHERE group_id=$1`, [groupId]);
  await q(`DELETE FROM contributions WHERE group_id=$1`, [groupId]);
  await q(`DELETE FROM withdrawal_requests WHERE group_id=$1`, [groupId]);
  await q(`DELETE FROM committee_pools WHERE group_id=$1`, [groupId]);
  await q(`DELETE FROM group_messages WHERE group_id=$1`, [groupId]);
  await q(`DELETE FROM group_invitations WHERE group_id=$1`, [groupId]);
  await q(`DELETE FROM group_members WHERE group_id=$1`, [groupId]);
  await q(`DELETE FROM transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE group_id=$1)`, [groupId]);
  await q(`DELETE FROM lipila_transactions WHERE group_id=$1`, [groupId]);
  await q(`DELETE FROM wallets WHERE group_id=$1`, [groupId]);
}

async function upsertGroup(cfg) {
  const { rows } = await q(
    `INSERT INTO groups
       (name, description, slug, status, monthly_amount, currency, max_members,
        contribution_day, payout_day, min_approvals_withdrawal, invite_code, created_by,
        grace_period_days, late_fee_type, late_fee_value, payout_order_mode,
        contribution_threshold_percent, payout_approval_mode, payout_approvals_required,
        schedule_locked, members_locked)
     VALUES ($1,$2,$3,'active',$4,'ZMW',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (slug) DO UPDATE SET
       name=EXCLUDED.name, description=EXCLUDED.description, monthly_amount=EXCLUDED.monthly_amount,
       max_members=EXCLUDED.max_members, contribution_day=EXCLUDED.contribution_day, payout_day=EXCLUDED.payout_day,
       min_approvals_withdrawal=EXCLUDED.min_approvals_withdrawal, invite_code=EXCLUDED.invite_code,
       grace_period_days=EXCLUDED.grace_period_days, late_fee_type=EXCLUDED.late_fee_type,
       late_fee_value=EXCLUDED.late_fee_value, payout_order_mode=EXCLUDED.payout_order_mode,
       contribution_threshold_percent=EXCLUDED.contribution_threshold_percent,
       payout_approval_mode=EXCLUDED.payout_approval_mode, payout_approvals_required=EXCLUDED.payout_approvals_required,
       schedule_locked=EXCLUDED.schedule_locked, members_locked=EXCLUDED.members_locked
     RETURNING id`,
    [cfg.name, cfg.description, cfg.slug, cfg.monthly, cfg.maxMembers, cfg.contributionDay, cfg.payoutDay,
     cfg.minApprovalsWithdrawal, cfg.inviteCode, cfg.createdBy, cfg.gracePeriodDays, cfg.lateFeeType,
     cfg.lateFeeValue, cfg.payoutOrderMode, cfg.thresholdPercent, cfg.approvalMode, cfg.approvalsRequired,
     !!cfg.scheduleLocked, !!cfg.membersLocked]
  );
  return rows[0].id;
}

async function addMember(groupId, userId, role, order, permissions = [], joinedDaysAgo = 30) {
  await q(
    `INSERT INTO group_members (group_id, user_id, role, status, payout_order, joined_at, permissions)
     VALUES ($1,$2,$3,'active',$4,$5,$6)`,
    [groupId, userId, role, order, iso(daysAgo(joinedDaysAgo)), permissions]
  );
}

async function addContribution(groupId, userId, cfg) {
  const ref = `SEED-${groupId.slice(0, 6)}-${cfg.cycle}-${cfg.round}-${userId.slice(0, 6)}`.toUpperCase();
  await q(
    `INSERT INTO contributions
       (group_id, user_id, cycle_number, round_number, amount_due, amount_paid, status, due_date, paid_at, late_fee_charged, reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [groupId, userId, cfg.cycle, cfg.round, cfg.amount, cfg.paid || 0, cfg.status,
     isoDate(cfg.due), cfg.paidAt ? iso(cfg.paidAt) : null, cfg.lateFee || 0, ref]
  );
}

async function addPayout(groupId, userId, cfg) {
  const { rows } = await q(
    `INSERT INTO payout_schedule
       (group_id, user_id, cycle_number, payout_order, scheduled_date, expected_amount, status, actual_amount, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [groupId, userId, cfg.cycle, cfg.order, isoDate(cfg.date), cfg.expected, cfg.status || 'scheduled',
     cfg.actual || null, cfg.paidAt ? iso(cfg.paidAt) : null]
  );
  return rows[0].id;
}

async function approvePayout(scheduleId, approverId, action = 'approved') {
  await q(
    `INSERT INTO payout_approvals (payout_schedule_id, approver_id, action)
     VALUES ($1,$2,$3) ON CONFLICT (payout_schedule_id, approver_id) DO UPDATE SET action=EXCLUDED.action`,
    [scheduleId, approverId, action]
  );
}

async function addMomo(userId, number, provider) {
  await q(
    `INSERT INTO user_payment_methods (user_id, type, mobile_number, mobile_provider, is_default)
     VALUES ($1,'mobile_money',$2,$3,true)
     ON CONFLICT (user_id, type) DO UPDATE SET mobile_number=EXCLUDED.mobile_number, mobile_provider=EXCLUDED.mobile_provider`,
    [userId, number, provider]
  );
}
async function addBank(userId, bank, account, name, branch) {
  await q(
    `INSERT INTO user_payment_methods (user_id, type, bank_name, account_number, account_name, branch, is_default)
     VALUES ($1,'bank',$2,$3,$4,$5,true)
     ON CONFLICT (user_id, type) DO UPDATE SET bank_name=EXCLUDED.bank_name, account_number=EXCLUDED.account_number, account_name=EXCLUDED.account_name, branch=EXCLUDED.branch`,
    [userId, bank, account, name, branch]
  );
}

async function addLipila(cfg) {
  await q(
    `INSERT INTO lipila_transactions
       (reference_id, lipila_id, type, status, amount, currency, account_number, payment_type, narration, wallet_id, user_id, group_id, webhook_received_at)
     VALUES ($1,$2,$3,$4,$5,'ZMW',$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (reference_id) DO NOTHING`,
    [crypto.randomBytes(16).toString('hex'), cfg.lipilaId || null, cfg.type, cfg.status, cfg.amount,
     cfg.account || null, cfg.paymentType || null, cfg.narration || 'Chilimba wallet top-up',
     cfg.walletId || null, cfg.userId, cfg.groupId || null,
     cfg.status !== 'pending' ? iso(new Date()) : null]
  );
}

async function addNotification(userId, type, title, body) {
  await q(`INSERT INTO notifications (user_id, type, title, body) VALUES ($1,$2,$3,$4)`, [userId, type, title, body]);
}
async function addMessage(groupId, userId, content) {
  await q(`INSERT INTO group_messages (group_id, user_id, content) VALUES ($1,$2,$3)`, [groupId, userId, content]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function seed() {
  console.log('🌱 Seeding Chilimba test data...\n');

  const uid = {};
  for (const u of USERS) uid[u.email] = await upsertUser(u);
  console.log(`  ✅ ${USERS.length} users`);

  // Reset personal-wallet ledgers for seeded users (keeps their real-user data untouched)
  for (const id of Object.values(uid)) {
    await q(`DELETE FROM transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE owner_id=$1 AND group_id IS NULL)`, [id]);
    await q(`DELETE FROM lipila_transactions WHERE user_id=$1`, [id]);
    await personalWallet(id, 0);
  }

  const B = uid['bwalya@example.com'], M = uid['mwansa@example.com'], C = uid['chipo@example.com'];
  const N = uid['natasha@example.com'], K = uid['kabwe@example.com'], T = uid['temba@example.com'];

  // ══ GROUP A — Lusaka North: majority approval, 100% threshold, READY TO DISBURSE ══
  {
    const gid = await upsertGroup({
      name: 'Lusaka North Chilimba', description: 'Community savings — everything paid, votes in, ready for the first payout.',
      slug: 'lusaka-north-chilimba', monthly: 500, maxMembers: 6, contributionDay: 1, payoutDay: 25,
      minApprovalsWithdrawal: 2, inviteCode: 'DEMO1234', createdBy: B, gracePeriodDays: 5,
      lateFeeType: 'none', lateFeeValue: 0, payoutOrderMode: 'fixed', thresholdPercent: 100,
      approvalMode: 'majority', approvalsRequired: 0,
    });
    await resetGroupChildren(gid);
    await addMember(gid, B, 'owner', 1, ['approver']);
    await addMember(gid, M, 'member', 2, ['approver']);
    await addMember(gid, C, 'member', 3, []);
    const due = daysAgo(2);
    for (const u of [B, M, C]) {
      await addContribution(gid, u, { cycle: 1, round: 1, amount: 500, paid: 500, status: 'paid', due, paidAt: daysAgo(1) });
      await groupWallet(u, gid, 500);
    }
    const p1 = await addPayout(gid, B, { cycle: 1, order: 1, date: monthsAhead(0), expected: 1500 });
    await addPayout(gid, M, { cycle: 1, order: 2, date: monthsAhead(1), expected: 1500 });
    await addPayout(gid, C, { cycle: 1, order: 3, date: monthsAhead(2), expected: 1500 });
    await approvePayout(p1, M);  // 2 approvals (majority of 3) → ready
    await approvePayout(p1, C);
    // A pending email invitation for Mutale
    const token = crypto.randomBytes(32).toString('hex');
    await q(`INSERT INTO group_invitations (group_id, invited_by, email, token, status) VALUES ($1,$2,$3,$4,'pending')`,
      [gid, B, 'mutale@example.com', token]);
    // A pending withdrawal request by Mwansa
    await q(`INSERT INTO withdrawal_requests (group_id, requested_by, amount, reason, status, approvals_needed, expires_at)
             VALUES ($1,$2,$3,$4,'pending_approval',2,$5)`,
      [gid, M, 300, 'Medical emergency — need to withdraw early.', iso(daysAhead(3))]);
    // Committee pool
    await q(`INSERT INTO committee_pools (group_id, created_by, title, description, category, target_amount, raised_amount, status, beneficiary)
             VALUES ($1,$2,$3,$4,'funeral',10000,3500,'active',$5)`,
      [gid, B, 'Funeral Support — Mama Banda', 'Support for the Banda family during this difficult time.', 'Banda Family']);
    await addMessage(gid, B, 'Welcome to Lusaka North Chilimba! Contributions are due on the 1st. 🎉');
    await addMessage(gid, M, 'All paid up on my end. Ready for the first payout!');
    console.log('  ✅ Group A "Lusaka North Chilimba" (DEMO1234) — ready to disburse to Bwalya');
    console.log(`     Invitation for mutale@example.com: /invitations/${token}`);
  }

  // ══ GROUP B — Kabwe Traders: NO approval, 80% threshold, auto-disburse ready ══
  {
    const gid = await upsertGroup({
      name: 'Kabwe Traders Circle', description: 'High-trust group — payouts release automatically, no vote needed.',
      slug: 'kabwe-traders-circle', monthly: 1000, maxMembers: 8, contributionDay: 5, payoutDay: 28,
      minApprovalsWithdrawal: 2, inviteCode: 'KABWE001', createdBy: N, gracePeriodDays: 3,
      lateFeeType: 'percentage', lateFeeValue: 5, payoutOrderMode: 'admin_assigned', thresholdPercent: 80,
      approvalMode: 'none', approvalsRequired: 0,
    });
    await resetGroupChildren(gid);
    await addMember(gid, N, 'owner', 1, ['approver']);
    await addMember(gid, K, 'member', 2, []);
    await addMember(gid, T, 'member', 3, []);
    const due = daysAgo(1);
    for (const u of [N, K, T]) {
      await addContribution(gid, u, { cycle: 1, round: 1, amount: 1000, paid: 1000, status: 'paid', due, paidAt: daysAgo(1) });
      await groupWallet(u, gid, 1000);
    }
    await addPayout(gid, N, { cycle: 1, order: 1, date: monthsAhead(0), expected: 3000 });
    await addPayout(gid, K, { cycle: 1, order: 2, date: monthsAhead(1), expected: 3000 });
    await addPayout(gid, T, { cycle: 1, order: 3, date: monthsAhead(2), expected: 3000 });
    await addMessage(gid, N, 'No voting here — payouts go out automatically once everyone has paid.');
    console.log('  ✅ Group B "Kabwe Traders Circle" (KABWE001) — no-approval, ready to auto-disburse');
  }

  // ══ GROUP C — Ndola Family: LOCKED, first payout already done ══
  {
    const gid = await upsertGroup({
      name: 'Ndola Family Savings', description: 'First payout done — schedule and membership are now locked.',
      slug: 'ndola-family-savings', monthly: 200, maxMembers: 5, contributionDay: 10, payoutDay: 20,
      minApprovalsWithdrawal: 2, inviteCode: 'NDOLA001', createdBy: C, gracePeriodDays: 5,
      lateFeeType: 'fixed', lateFeeValue: 20, payoutOrderMode: 'fixed', thresholdPercent: 100,
      approvalMode: 'majority', approvalsRequired: 0, scheduleLocked: true, membersLocked: true,
    });
    await resetGroupChildren(gid);
    await addMember(gid, C, 'owner', 1, ['approver']);
    await addMember(gid, B, 'member', 2, ['approver']);
    await addMember(gid, M, 'member', 3, []);
    const due = daysAgo(20);
    for (const u of [C, B, M]) {
      await addContribution(gid, u, { cycle: 1, round: 1, amount: 200, paid: 200, status: 'paid', due, paidAt: daysAgo(18) });
      await groupWallet(u, gid, 200);
    }
    // Order 1 (Chipo) already received; give Chipo a personal-wallet payout credit
    await addPayout(gid, C, { cycle: 1, order: 1, date: daysAgo(15), expected: 600, status: 'completed', actual: 600, paidAt: daysAgo(15) });
    const next = await addPayout(gid, B, { cycle: 1, order: 2, date: monthsAhead(0, 20), expected: 600 });
    await addPayout(gid, M, { cycle: 1, order: 3, date: monthsAhead(1, 20), expected: 600 });
    await approvePayout(next, C);  // 1 of 2 approvals so far — shows a pending vote
    await addMessage(gid, C, 'Thanks all — I received the first payout. Bwalya is next once we approve.');
    console.log('  ✅ Group C "Ndola Family Savings" (NDOLA001) — locked, 1st payout done, Bwalya next (1/2 votes)');
  }

  // ══ GROUP D — Kitwe Youth: contribution threshold NOT met (payout blocked) ══
  {
    const gid = await upsertGroup({
      name: 'Kitwe Youth Fund', description: 'Only one member has paid — the payout is blocked until the threshold is met.',
      slug: 'kitwe-youth-fund', monthly: 500, maxMembers: 10, contributionDay: 1, payoutDay: 25,
      minApprovalsWithdrawal: 3, inviteCode: 'KITWE001', createdBy: T, gracePeriodDays: 5,
      lateFeeType: 'fixed', lateFeeValue: 50, payoutOrderMode: 'random', thresholdPercent: 100,
      approvalMode: 'majority', approvalsRequired: 0,
    });
    await resetGroupChildren(gid);
    await addMember(gid, T, 'owner', 1, ['approver']);
    await addMember(gid, K, 'member', 2, []);
    await addMember(gid, B, 'member', 3, []);
    const overdue = daysAgo(10);
    await addContribution(gid, T, { cycle: 1, round: 1, amount: 500, paid: 500, status: 'paid', due: overdue, paidAt: daysAgo(9) });
    await groupWallet(T, gid, 500);
    await addContribution(gid, K, { cycle: 1, round: 1, amount: 500, paid: 0, status: 'pending', due: overdue });
    await addContribution(gid, B, { cycle: 1, round: 1, amount: 500, paid: 0, status: 'pending', due: overdue });
    await addPayout(gid, T, { cycle: 1, order: 1, date: monthsAhead(0), expected: 1500 });
    await addPayout(gid, K, { cycle: 1, order: 2, date: monthsAhead(1), expected: 1500 });
    await addPayout(gid, B, { cycle: 1, order: 3, date: monthsAhead(2), expected: 1500 });
    await addMessage(gid, T, 'Reminder: please pay your contributions so we can do the first payout. 🙏');
    console.log('  ✅ Group D "Kitwe Youth Fund" (KITWE001) — threshold NOT met (500/1500), payout blocked');
  }

  // ── Payment methods ────────────────────────────────────────────────────────
  await addMomo(B, '260976543210', 'mtn');
  await addMomo(C, '260978765432', 'airtel');
  await addMomo(T, '260979000003', 'zamtel');
  await addBank(N, 'Zanaco', '0123456789', 'Natasha Zulu', 'Cairo Road');
  console.log('  ✅ Payment methods (3 mobile money, 1 bank)');

  // ── Personal wallet deposits (Lipila collections + ledger) ──────────────────
  const bWallet = await personalWallet(B, 250);
  await addLipila({ type: 'collection', status: 'successful', amount: 250, account: '260976543210', paymentType: 'MTNMoney', walletId: bWallet, userId: B });
  await addLipila({ type: 'collection', status: 'pending', amount: 100, account: '260976543210', paymentType: 'MTNMoney', walletId: bWallet, userId: B });
  await q(`INSERT INTO transactions (wallet_id, type, direction, amount, balance_before, balance_after, status, reference_type, description)
           VALUES ($1,'deposit','credit',250,0,250,'completed','lipila_collection','MoMo top-up via MTNMoney')`, [bWallet]);
  const nWallet = await personalWallet(N, 1000);
  await addLipila({ type: 'collection', status: 'successful', amount: 1000, account: '260979000001', paymentType: 'AirtelMoney', walletId: nWallet, userId: N });
  await q(`INSERT INTO transactions (wallet_id, type, direction, amount, balance_before, balance_after, status, reference_type, description)
           VALUES ($1,'deposit','credit',1000,0,1000,'completed','lipila_collection','MoMo top-up via AirtelMoney')`, [nWallet]);
  console.log('  ✅ Wallet deposits (Bwalya 250 + pending 100, Natasha 1000)');

  // ── Custom role: "Treasurer" (group scope) assigned to Kabwe in Group B ──────
  const { rows: roleRows } = await q(
    `INSERT INTO roles (name, scope, description, is_system) VALUES ('treasurer','group','Manages group finances', false)
     ON CONFLICT (name, scope) DO UPDATE SET description=EXCLUDED.description RETURNING id`);
  const treasurerId = roleRows[0].id;
  for (const perm of ['payout.disburse', 'payout.set_order', 'withdrawal.vote']) {
    await q(`INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [treasurerId, perm]);
  }
  const { rows: gbRows } = await q(`SELECT id FROM groups WHERE slug='kabwe-traders-circle'`);
  await q(`INSERT INTO user_roles (user_id, role_id, group_id, granted_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, role_id, group_id) DO NOTHING`, [K, treasurerId, gbRows[0].id, N]);
  console.log('  ✅ Custom role "treasurer" → Kabwe (Group B)');

  // ── Notifications ────────────────────────────────────────────────────────────
  await addNotification(B, 'payout_scheduled',     'Payout ready',        'Your Lusaka North payout of ZMW 1,500 is approved and ready.');
  await addNotification(M, 'contribution_received', 'Contribution paid',   'Your ZMW 500 contribution to Lusaka North was received.');
  await addNotification(C, 'group_invite',          'Vote needed',         'A payout in Lusaka North needs your approval.');
  await addNotification(K, 'contribution_reminder', 'Contribution due',    'Your ZMW 500 contribution to Kitwe Youth Fund is overdue.');
  await addNotification(T, 'withdrawal_initiated',  'Withdrawal requested', 'Mwansa requested an early withdrawal in Lusaka North.');
  console.log('  ✅ Notifications');

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉  Seed complete — test users (all members password: ${MEMBER_PW})

  ROLE          EMAIL                          PASSWORD
  ───────────────────────────────────────────────────────────────────
  super_admin   superadmin@chilimba.app        Chilimba@2025!
  admin         admin@chilimba.app             Admin@2025!
  member        bwalya@example.com             ${MEMBER_PW}   ← owns Group A
  member        mwansa@example.com             ${MEMBER_PW}
  member        chipo@example.com              ${MEMBER_PW}   ← owns Group C
  member        natasha@example.com            ${MEMBER_PW}   ← owns Group B
  member        kabwe@example.com              ${MEMBER_PW}   ← "treasurer" in B
  member        temba@example.com              ${MEMBER_PW}   ← owns Group D
  member*       mutale@example.com             ${MEMBER_PW}   ← pending KYC + has invite to A
  member        suspended@example.com          ${MEMBER_PW}   ← suspended account

  TEST GROUPS
  ───────────────────────────────────────────────────────────────────
  A  Lusaka North Chilimba  DEMO1234  majority vote · READY TO DISBURSE (Bwalya)
  B  Kabwe Traders Circle   KABWE001  no-approval  · READY (auto) · 80% threshold
  C  Ndola Family Savings   NDOLA001  LOCKED · 1st payout done · Bwalya next (1/2 votes)
  D  Kitwe Youth Fund       KITWE001  payout BLOCKED · threshold not met (500/1500)

  SCENARIOS TO TEST
  ───────────────────────────────────────────────────────────────────
  • Disburse a payout          → log in as bwalya → Group A → Payouts → Disburse
  • Auto-payout (no approval)   → log in as natasha → Group B → Payouts → Disburse
  • Locks after first payout    → Group C: try to remove a member / reorder (blocked)
  • Threshold blocking          → Group D: Disburse is disabled, progress bar 33%
  • Approve a payout            → log in as chipo → Group C → approve Bwalya's payout
  • Accept an email invitation  → log in as mutale → open the /invitations link above
  • Withdrawal approval         → Group A has a pending withdrawal by Mwansa
  • Roles admin                 → superadmin → Roles: see "treasurer" assigned to Kabwe
  • Wallet + deposits           → bwalya has 250 + a pending 100 top-up
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

  await pool.end();
}

seed().catch(err => {
  console.error('\n❌ Seed failed:', err.message, '\n', err.stack);
  pool.end().finally(() => process.exit(1));
});
