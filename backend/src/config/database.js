const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

/**
 * Run `fn` inside a real transaction on a single pooled connection.
 *
 * Note: issuing BEGIN/COMMIT via pool.query() does NOT work - each query can
 * land on a different connection, so the COMMIT may not cover the writes and
 * the ROLLBACK may not undo them. Always use this helper instead.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Take a transaction-scoped advisory lock on an arbitrary string key.
 * Serialises concurrent work on the same logical entity (e.g. a Shopify order
 * id) without needing a row to lock. Released automatically on COMMIT/ROLLBACK.
 */
async function advisoryXactLock(client, key) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(key)]);
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  withTransaction,
  advisoryXactLock,
  pool,
};
