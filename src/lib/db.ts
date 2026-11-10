/**
 * One shared PostgreSQL pool per server instance (cached on globalThis so dev hot-reload doesn't leak pools).
 * Rule: never keep a transaction open while waiting on the AI model; transactions here are milliseconds long.
 */
import { Pool, type PoolClient } from 'pg';

const globalDb = globalThis as unknown as { welfarePool?: Pool };

export function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  // Small pool: on serverless each instance has its own pool; use Neon's pooled URL in production.
  return (globalDb.welfarePool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  }));
}

/** BEGIN -> work -> COMMIT, or ROLLBACK on any error. */
export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
