/**
 * Postgres pool + RLS helper.
 *
 * Every request that touches RLS-protected tables must run through `withUserContext`,
 * which acquires a connection, sets the per-connection `app.current_user_id` config,
 * runs the callback with that connection, and releases it. Connections are NOT shared
 * across requests, so the context is implicitly scoped to the callback.
 */

import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  // Phase 1 single-user, low concurrency. Bump for Phase 5+.
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] unexpected pool error:', err);
});

export type DbClient = pg.PoolClient;

/**
 * Acquire a connection, set RLS context, run `fn` with it, release.
 * Use for any query that reads/writes RLS-protected tables.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT set_user_context($1::uuid)', [userId]);
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Run a single query with RLS context set. Convenience wrapper.
 */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  userId: string,
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<R>> {
  return withUserContext(userId, (client) => client.query<R>(text, params));
}
