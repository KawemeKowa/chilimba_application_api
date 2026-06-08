const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const { Pool } = require('pg');

const isRemote = (process.env.DB_HOST || 'localhost') !== 'localhost';

const pool = new Pool({
  host:             process.env.DB_HOST     || 'localhost',
  port:             parseInt(process.env.DB_PORT || '5432'),
  database:         process.env.DB_NAME     || 'chilimba_db',
  user:             process.env.DB_USER     || 'chilimba_user',
  password:         process.env.DB_PASSWORD || '',
  max:              parseInt(process.env.DB_POOL_MAX || '20'),
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000'),
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECTION_TIMEOUT || '2000'),
  ssl: isRemote ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

/**
 * Execute a single query
 */
const query = (text, params) => pool.query(text, params);

/**
 * Get a client for transactions
 */
const getClient = () => pool.connect();

/**
 * Run a set of queries in a transaction block
 * @param {Function} fn - async function receiving (client)
 */
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { query, getClient, withTransaction, pool };
