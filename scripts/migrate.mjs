/** Applies versioned SQL once, under a database lock. Requires the local server-only DATABASE_URL. */
import { readFile } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL in .env.local first.');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(824731)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const name = '001-initial.sql';
  const existing = await client.query('SELECT name FROM schema_migrations WHERE name=$1', [name]);
  if (!existing.rowCount) {
    await client.query(await readFile(new URL('../db/001-initial.sql', import.meta.url), 'utf8'));
    await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
  }
  await client.query('COMMIT');
  console.log('Database migrations are up to date.');
} catch (error) { await client.query('ROLLBACK'); throw error; }
finally { await client.end(); }
