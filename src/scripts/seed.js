require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

// Uses the Supabase REST API over HTTPS — works even when direct PostgreSQL
// connections are blocked (e.g. no IPv6 connectivity in the Africa region).
// Node 20 needs ws passed explicitly (native WebSocket only in Node 22+).
const ws = require('ws');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,  // service role bypasses RLS
  { realtime: { transport: ws } }
);

// ─── Seed data ────────────────────────────────────────────────────────────────

const USERS = [
  {
    first_name: 'Super', last_name: 'Admin',
    email: 'superadmin@chilimba.app', phone: '+260971000001',
    password: 'Chilimba@2025!', role: 'super_admin', status: 'active',
    id_verified: true, date_of_birth: '1980-01-01',
  },
  {
    first_name: 'Platform', last_name: 'Admin',
    email: 'admin@chilimba.app', phone: '+260971000002',
    password: 'Admin@2025!', role: 'admin', status: 'active',
    id_verified: true, date_of_birth: '1985-06-15',
  },
  {
    first_name: 'Bwalya', last_name: 'Mwale',
    email: 'bwalya@example.com', phone: '+260976543210',
    password: 'Member@2025!', role: 'member', status: 'active',
    id_verified: true, date_of_birth: '1992-03-14',
  },
  {
    first_name: 'Mwansa', last_name: 'Chanda',
    email: 'mwansa@example.com', phone: '+260977654321',
    password: 'Member@2025!', role: 'member', status: 'active',
    id_verified: true, date_of_birth: '1988-07-22',
  },
  {
    first_name: 'Chipo', last_name: 'Banda',
    email: 'chipo@example.com', phone: '+260978765432',
    password: 'Member@2025!', role: 'member', status: 'active',
    id_verified: true, date_of_birth: '1995-11-05',
  },
  {
    first_name: 'Mutale', last_name: 'Phiri',
    email: 'mutale@example.com', phone: '+260979876543',
    password: 'Member@2025!', role: 'member', status: 'pending_verification',
    id_verified: false, date_of_birth: '2000-01-30',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsert(table, rows, onConflict) {
  const { data, error } = await supabase
    .from(table)
    .upsert(rows, { onConflict, ignoreDuplicates: false })
    .select();
  if (error) throw new Error(`[${table}] ${error.message}`);
  return data;
}

async function insertIfAbsent(table, rows, matchCol) {
  for (const row of rows) {
    const { data: existing } = await supabase
      .from(table)
      .select('id')
      .eq(matchCol, row[matchCol])
      .maybeSingle();
    if (existing) continue;
    const { error } = await supabase.from(table).insert(row);
    if (error) throw new Error(`[${table}] ${error.message}`);
  }
}

function monthFromNow(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  d.setDate(25);
  return d.toISOString().split('T')[0];
}

function startOfThisMonth() {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().split('T')[0];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function seed() {
  console.log('🌱 Seeding Chilimba database via Supabase REST API...\n');

  // ── 1. Users ─────────────────────────────────────────────────────────────
  const userRows = [];
  for (const u of USERS) {
    const password_hash = await bcrypt.hash(u.password, 10);
    userRows.push({
      first_name: u.first_name,
      last_name:  u.last_name,
      email:      u.email,
      phone:      u.phone,
      password_hash,
      role:         u.role,
      status:       u.status,
      id_verified:  u.id_verified,
      date_of_birth: u.date_of_birth,
    });
  }

  const insertedUsers = await upsert('users', userRows, 'email');
  console.log(`  ✅ ${insertedUsers.length} users upserted`);

  // Build email → id map
  const uid = {};
  for (const u of insertedUsers) uid[u.email] = u.id;

  // ── 2. Personal wallets ───────────────────────────────────────────────────
  for (const [email, id] of Object.entries(uid)) {
    const { data: existing } = await supabase
      .from('wallets')
      .select('id')
      .eq('owner_id', id)
      .eq('type', 'personal')
      .is('group_id', null)
      .maybeSingle();
    if (!existing) {
      const { error } = await supabase
        .from('wallets')
        .insert({ owner_id: id, type: 'personal', balance: 0, currency: 'ZMW' });
      if (error) throw new Error(`[wallets:personal:${email}] ${error.message}`);
    }
  }
  console.log('  ✅ Personal wallets ready');

  // ── 3. Demo group ─────────────────────────────────────────────────────────
  const ownerId = uid['bwalya@example.com'];
  const MONTHLY = 500;
  const MEMBER_EMAILS = ['bwalya@example.com', 'mwansa@example.com', 'chipo@example.com'];

  let groupId;
  const { data: existingGroup } = await supabase
    .from('groups')
    .select('id')
    .eq('slug', 'lusaka-north-chilimba')
    .maybeSingle();

  if (existingGroup) {
    groupId = existingGroup.id;
  } else {
    const { data: newGroup, error } = await supabase
      .from('groups')
      .insert({
        name: 'Lusaka North Chilimba',
        description: 'Community savings group for Lusaka North residents',
        slug: 'lusaka-north-chilimba',
        status: 'active',
        monthly_amount: MONTHLY,
        currency: 'ZMW',
        max_members: 6,
        contribution_day: 1,
        payout_day: 25,
        min_approvals_withdrawal: 2,
        invite_code: 'DEMO1234',
        created_by: ownerId,
      })
      .select()
      .single();
    if (error) throw new Error(`[groups] ${error.message}`);
    groupId = newGroup.id;
  }
  console.log(`  ✅ Demo group ready  →  invite code: DEMO1234`);

  // ── 4. Group wallet ───────────────────────────────────────────────────────
  const { data: existingGW } = await supabase
    .from('wallets')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('type', 'group')
    .eq('group_id', groupId)
    .maybeSingle();
  if (!existingGW) {
    const { error } = await supabase
      .from('wallets')
      .insert({ owner_id: ownerId, type: 'group', group_id: groupId, balance: 0, currency: 'ZMW' });
    if (error) throw new Error(`[wallets:group] ${error.message}`);
  }

  // ── 5. Group members + payout schedule ───────────────────────────────────
  for (let i = 0; i < MEMBER_EMAILS.length; i++) {
    const memberId   = uid[MEMBER_EMAILS[i]];
    const payoutOrder = i + 1;
    const role       = i === 0 ? 'owner' : 'member';

    const { data: existingMember } = await supabase
      .from('group_members')
      .select('id')
      .eq('group_id', groupId)
      .eq('user_id', memberId)
      .maybeSingle();

    if (!existingMember) {
      const { error } = await supabase.from('group_members').insert({
        group_id: groupId,
        user_id:  memberId,
        role,
        status:       'active',
        payout_order: payoutOrder,
        joined_at:    new Date().toISOString(),
      });
      if (error) throw new Error(`[group_members] ${error.message}`);
    }

    const { data: existingPS } = await supabase
      .from('payout_schedule')
      .select('id')
      .eq('group_id', groupId)
      .eq('cycle_number', 1)
      .eq('payout_order', payoutOrder)
      .maybeSingle();

    if (!existingPS) {
      const { error } = await supabase.from('payout_schedule').insert({
        group_id:        groupId,
        user_id:         memberId,
        cycle_number:    1,
        payout_order:    payoutOrder,
        scheduled_date:  monthFromNow(payoutOrder),
        expected_amount: MONTHLY * MEMBER_EMAILS.length,
        status:          'scheduled',
      });
      if (error) throw new Error(`[payout_schedule] ${error.message}`);
    }
  }
  console.log(`  ✅ ${MEMBER_EMAILS.length} members + payout schedule (cycle 1)`);

  // ── 6. Contributions (cycle 1, round 1) ──────────────────────────────────
  const dueDate = startOfThisMonth();
  for (let i = 0; i < MEMBER_EMAILS.length; i++) {
    const memberId = uid[MEMBER_EMAILS[i]];
    const paid     = i === 0; // Bwalya already paid

    const { data: existingC } = await supabase
      .from('contributions')
      .select('id')
      .eq('group_id', groupId)
      .eq('user_id', memberId)
      .eq('cycle_number', 1)
      .eq('round_number', 1)
      .maybeSingle();

    if (!existingC) {
      const { error } = await supabase.from('contributions').insert({
        group_id:     groupId,
        user_id:      memberId,
        cycle_number: 1,
        round_number: 1,
        amount_due:   MONTHLY,
        amount_paid:  paid ? MONTHLY : 0,
        status:       paid ? 'paid' : 'pending',
        due_date:     dueDate,
        paid_at:      paid ? new Date().toISOString() : null,
      });
      if (error) throw new Error(`[contributions] ${error.message}`);
    }
  }
  console.log('  ✅ Contributions seeded  (Bwalya: paid, others: pending)');

  // ── 7. Ledger transaction for Bwalya's paid contribution ─────────────────
  const { data: bwalyaWallet } = await supabase
    .from('wallets')
    .select('id')
    .eq('owner_id', uid['bwalya@example.com'])
    .eq('type', 'personal')
    .is('group_id', null)
    .maybeSingle();

  if (bwalyaWallet) {
    const { data: existingTxn } = await supabase
      .from('transactions')
      .select('id')
      .eq('wallet_id', bwalyaWallet.id)
      .eq('reference_type', 'contribution')
      .maybeSingle();

    if (!existingTxn) {
      const { error } = await supabase.from('transactions').insert({
        wallet_id:      bwalyaWallet.id,
        type:           'contribution',
        direction:      'debit',
        amount:         MONTHLY,
        balance_before: 0,
        balance_after:  0,
        status:         'completed',
        reference_type: 'contribution',
        description:    'Cycle 1 Round 1 — Lusaka North Chilimba',
      });
      if (error) throw new Error(`[transactions] ${error.message}`);
    }
  }
  console.log('  ✅ Ledger transaction recorded for Bwalya');

  // ── 8. Committee pool ─────────────────────────────────────────────────────
  const { data: existingPool } = await supabase
    .from('committee_pools')
    .select('id')
    .eq('group_id', groupId)
    .eq('title', 'Funeral Support — Mama Banda')
    .maybeSingle();

  if (!existingPool) {
    const { error } = await supabase.from('committee_pools').insert({
      group_id:     groupId,
      created_by:   ownerId,
      title:        'Funeral Support — Mama Banda',
      description:  'Contributions to support the Banda family during this difficult time.',
      category:     'funeral',
      target_amount: 10000,
      status:       'active',
    });
    if (error) throw new Error(`[committee_pools] ${error.message}`);
  }
  console.log('  ✅ Committee pool  →  Funeral Support — Mama Banda');

  // ── 9. Welcome message ────────────────────────────────────────────────────
  const { data: existingMsg } = await supabase
    .from('group_messages')
    .select('id')
    .eq('group_id', groupId)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (!existingMsg) {
    const { error } = await supabase.from('group_messages').insert({
      group_id: groupId,
      user_id:  ownerId,
      content:  'Welcome to Lusaka North Chilimba! Contributions are due on the 1st of each month. 🎉',
    });
    if (error) throw new Error(`[group_messages] ${error.message}`);
  }
  console.log('  ✅ Welcome message posted');

  // ── 10. Contribution reminder notifications ───────────────────────────────
  for (const email of MEMBER_EMAILS) {
    const memberId = uid[email];
    const { data: existingN } = await supabase
      .from('notifications')
      .select('id')
      .eq('user_id', memberId)
      .eq('type', 'contribution_reminder')
      .maybeSingle();

    if (!existingN) {
      const { error } = await supabase.from('notifications').insert({
        user_id: memberId,
        type:    'contribution_reminder',
        title:   'Contribution Due',
        body:    'Your ZMW 500 contribution for Lusaka North Chilimba is due on the 1st.',
      });
      if (error) throw new Error(`[notifications] ${error.message}`);
    }
  }
  console.log('  ✅ Contribution reminder notifications sent');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎉  Seed complete!

  ROLE          EMAIL                         PASSWORD
  ─────────────────────────────────────────────────────
  super_admin   superadmin@chilimba.app       Chilimba@2025!
  admin         admin@chilimba.app            Admin@2025!
  member        bwalya@example.com            Member@2025!  ← group owner
  member        mwansa@example.com            Member@2025!
  member        chipo@example.com             Member@2025!
  member*       mutale@example.com            Member@2025!  ← pending KYC

  Demo Group    Lusaka North Chilimba
  Invite Code   DEMO1234
  Committee     Funeral Support — Mama Banda (active)

  * mutale is not in the demo group — use invite DEMO1234 to join

  ⚠️  Change admin passwords immediately in production!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
}

seed().catch(err => {
  console.error('\n❌ Seed failed:', err.message);
  process.exit(1);
});
