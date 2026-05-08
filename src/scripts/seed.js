require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function seed() {
  const client = await pool.connect();
  try {
    // Super Admin
    const passwordHash = await bcrypt.hash('Chilimba@2025!', 12);
    await client.query(`
      INSERT INTO users (first_name, last_name, email, phone, password_hash, role, status, id_verified)
      VALUES ('Super', 'Admin', 'superadmin@chilimba.app', '+260971000001', $1, 'super_admin', 'active', TRUE)
      ON CONFLICT (email) DO NOTHING
    `, [passwordHash]);

    // Platform Admin
    const adminHash = await bcrypt.hash('Admin@2025!', 12);
    await client.query(`
      INSERT INTO users (first_name, last_name, email, phone, password_hash, role, status, id_verified)
      VALUES ('Platform', 'Admin', 'admin@chilimba.app', '+260971000002', $1, 'admin', 'active', TRUE)
      ON CONFLICT (email) DO NOTHING
    `, [adminHash]);

    console.log('✅ Seed complete');
    console.log('  Super Admin: superadmin@chilimba.app / Chilimba@2025!');
    console.log('  Admin:       admin@chilimba.app / Admin@2025!');
    console.log('\n  ⚠️  Change these passwords immediately in production!');
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(console.error);
