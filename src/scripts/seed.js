require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    })
  : new Pool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME     || 'chilimba_db',
      user:     process.env.DB_USER     || 'chilimba_user',
      password: process.env.DB_PASSWORD || '',
    });

const q = (text, params) => pool.query(text, params);

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
  console.log('🌱 Seeding Chilimba database via pg (Railway PostgreSQL)...\n');

  // ── 1. Users ─────────────────────────────────────────────────────────────
  const uid = {};
  for (const u of USERS) {
    const password_hash = await bcrypt.hash(u.password, 10);
    const { rows } = await q(
      `INSERT INTO users
         (first_name, last_name, email, phone, password_hash, role, status, id_verified, date_of_birth)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (email) DO UPDATE SET
         first_name    = EXCLUDED.first_name,
         last_name     = EXCLUDED.last_name,
         phone         = EXCLUDED.phone,
         password_hash = EXCLUDED.password_hash,
         role          = EXCLUDED.role,
         status        = EXCLUDED.status,
         id_verified   = EXCLUDED.id_verified,
         date_of_birth = EXCLUDED.date_of_birth
       RETURNING id, email`,
      [u.first_name, u.last_name, u.email, u.phone, password_hash,
       u.role, u.status, u.id_verified, u.date_of_birth]
    );
    uid[rows[0].email] = rows[0].id;
  }
  console.log(`  ✅ ${USERS.length} users upserted`);

  // ── 2. Personal wallets ───────────────────────────────────────────────────
  for (const id of Object.values(uid)) {
    await q(
      `INSERT INTO wallets (owner_id, type, balance, currency)
       VALUES ($1, 'personal', 0, 'ZMW')
       ON CONFLICT DO NOTHING`,
      [id]
    );
  }
  console.log('  ✅ Personal wallets ready');

  // ── 3. Demo group ─────────────────────────────────────────────────────────
  const ownerId = uid['bwalya@example.com'];
  const MONTHLY = 500;
  const MEMBER_EMAILS = ['bwalya@example.com', 'mwansa@example.com', 'chipo@example.com'];

  const { rows: groupRows } = await q(
    `INSERT INTO groups
       (name, description, slug, status, monthly_amount, currency,
        max_members, contribution_day, payout_day,
        min_approvals_withdrawal, invite_code, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id`,
    [
      'Lusaka North Chilimba',
      'Community savings group for Lusaka North residents',
      'lusaka-north-chilimba', 'active', MONTHLY, 'ZMW',
      6, 1, 25, 2, 'DEMO1234', ownerId,
    ]
  );
  const groupId = groupRows[0].id;
  console.log(`  ✅ Demo group ready  →  invite code: DEMO1234`);

  // ── 4. Group wallet ───────────────────────────────────────────────────────
  await q(
    `INSERT INTO wallets (owner_id, type, group_id, balance, currency)
     VALUES ($1, 'group', $2, 0, 'ZMW')
     ON CONFLICT DO NOTHING`,
    [ownerId, groupId]
  );

  // ── 5. Group members + payout schedule ───────────────────────────────────
  for (let i = 0; i < MEMBER_EMAILS.length; i++) {
    const memberId    = uid[MEMBER_EMAILS[i]];
    const payoutOrder = i + 1;
    const role        = i === 0 ? 'owner' : 'member';

    await q(
      `INSERT INTO group_members (group_id, user_id, role, status, payout_order, joined_at)
       VALUES ($1,$2,$3,'active',$4,NOW())
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [groupId, memberId, role, payoutOrder]
    );

    await q(
      `INSERT INTO payout_schedule
         (group_id, user_id, cycle_number, payout_order, scheduled_date, expected_amount, status)
       VALUES ($1,$2,1,$3,$4,$5,'scheduled')
       ON CONFLICT DO NOTHING`,
      [groupId, memberId, payoutOrder, monthFromNow(payoutOrder), MONTHLY * MEMBER_EMAILS.length]
    );
  }
  console.log(`  ✅ ${MEMBER_EMAILS.length} members + payout schedule (cycle 1)`);

  // ── 6. Contributions (cycle 1, round 1) ──────────────────────────────────
  const dueDate = startOfThisMonth();
  for (let i = 0; i < MEMBER_EMAILS.length; i++) {
    const memberId = uid[MEMBER_EMAILS[i]];
    const paid     = i === 0; // Bwalya already paid

    await q(
      `INSERT INTO contributions
         (group_id, user_id, cycle_number, round_number,
          amount_due, amount_paid, status, due_date, paid_at)
       VALUES ($1,$2,1,1,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [
        groupId, memberId, MONTHLY,
        paid ? MONTHLY : 0,
        paid ? 'paid' : 'pending',
        dueDate,
        paid ? new Date().toISOString() : null,
      ]
    );
  }
  console.log('  ✅ Contributions seeded  (Bwalya: paid, others: pending)');

  // ── 7. Ledger transaction for Bwalya's paid contribution ─────────────────
  const { rows: walletRows } = await q(
    `SELECT id FROM wallets
     WHERE owner_id = $1 AND type = 'personal' AND group_id IS NULL
     LIMIT 1`,
    [uid['bwalya@example.com']]
  );

  if (walletRows.length) {
    const walletId = walletRows[0].id;
    const { rows: txnRows } = await q(
      `SELECT id FROM transactions
       WHERE wallet_id = $1 AND reference_type = 'contribution'
       LIMIT 1`,
      [walletId]
    );
    if (!txnRows.length) {
      await q(
        `INSERT INTO transactions
           (wallet_id, type, direction, amount, balance_before, balance_after,
            status, reference_type, description)
         VALUES ($1,'contribution','debit',$2,0,0,'completed','contribution',$3)`,
        [walletId, MONTHLY, 'Cycle 1 Round 1 — Lusaka North Chilimba']
      );
    }
  }
  console.log('  ✅ Ledger transaction recorded for Bwalya');

  // ── 8. Committee pool ─────────────────────────────────────────────────────
  await q(
    `INSERT INTO committee_pools
       (group_id, created_by, title, description, category, target_amount, status)
     VALUES ($1,$2,$3,$4,'funeral',10000,'active')
     ON CONFLICT DO NOTHING`,
    [
      groupId, ownerId,
      'Funeral Support — Mama Banda',
      'Contributions to support the Banda family during this difficult time.',
    ]
  );
  console.log('  ✅ Committee pool  →  Funeral Support — Mama Banda');

  // ── 9. Welcome message ────────────────────────────────────────────────────
  const { rows: msgRows } = await q(
    `SELECT id FROM group_messages WHERE group_id = $1 AND user_id = $2 LIMIT 1`,
    [groupId, ownerId]
  );
  if (!msgRows.length) {
    await q(
      `INSERT INTO group_messages (group_id, user_id, content)
       VALUES ($1,$2,$3)`,
      [groupId, ownerId, 'Welcome to Lusaka North Chilimba! Contributions are due on the 1st of each month. 🎉']
    );
  }
  console.log('  ✅ Welcome message posted');

  // ── 10. Contribution reminder notifications ───────────────────────────────
  for (const email of MEMBER_EMAILS) {
    const memberId = uid[email];
    const { rows: notifRows } = await q(
      `SELECT id FROM notifications
       WHERE user_id = $1 AND type = 'contribution_reminder' LIMIT 1`,
      [memberId]
    );
    if (!notifRows.length) {
      await q(
        `INSERT INTO notifications (user_id, type, title, body)
         VALUES ($1,'contribution_reminder',$2,$3)`,
        [
          memberId,
          'Contribution Due',
          'Your ZMW 500 contribution for Lusaka North Chilimba is due on the 1st.',
        ]
      );
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

  await pool.end();
}

seed().catch(err => {
  console.error('\n❌ Seed failed:', err.message);
  pool.end().finally(() => process.exit(1));
});
