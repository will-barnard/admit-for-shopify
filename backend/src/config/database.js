const { Pool, types } = require('pg');

/**
 * Hand back naive dates and timestamps exactly as Postgres stores them.
 *
 * By default node-postgres turns DATE and TIMESTAMP WITHOUT TIME ZONE into a
 * JS Date by interpreting them in the SERVER PROCESS's zone, and Express then
 * serialises that to UTC. So an event starting at 10:00 came out of the API as
 * "2026-11-14T16:00:00.000Z" on a machine set to America/Chicago - six hours
 * wrong - and right only by accident on a container running UTC.
 *
 * These columns have no zone because they are not meant to have one: a venue
 * saying "doors at 7 on the 14th" means local wall-clock time, and so does the
 * person on the door checking a day pass. Returning the raw string keeps that
 * meaning intact end to end.
 *
 * TIMESTAMPTZ (1184) is deliberately left alone - that one really does carry a
 * zone, and a Date is the right thing for it.
 */
types.setTypeParser(1082, (value) => value); // date
types.setTypeParser(1114, (value) => value); // timestamp without time zone

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
