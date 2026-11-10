/**
 * `npm run test:db`: real PostgreSQL checks, in a throwaway schema that is dropped afterwards.
 * Proves what unit tests can't: the crisis case is durably saved, retries don't duplicate,
 * and two simultaneous claims produce exactly one owner and one 409 (at service level AND over HTTP).
 */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { sendMessage, transcript } from '../../src/lib/conversation-service';
import { caseDetail, claimCase, resolveCase } from '../../src/lib/staff-service';
import type { ModelFn } from '../../src/lib/model';
import { crisisMessage, routineProposal } from '../fixtures';

const stub = (raw: unknown): ModelFn => async () => ({ raw, providerStatus: 'fixture', attempts: 1 });

async function serviceChecks(pool: Pool) {
  const id = randomUUID();
  await pool.query('INSERT INTO conversations (id, session_hash, name, email) VALUES ($1, $2, $3, $4)', [id, randomUUID(), 'Synthetic Student', 'student@example.invalid']);

  // Crisis: saved as a critical case before any model call; retrying the same request creates nothing new.
  const requestId = randomUUID();
  const { turn, needsAudit } = await sendMessage(id, requestId, crisisMessage, stub(routineProposal));
  assert.equal(turn.disposition, 'escalate');
  assert.equal(turn.emergency, true);
  assert.equal(needsAudit, true);
  const cases = await pool.query('SELECT * FROM cases WHERE conversation_id = $1', [id]);
  assert.equal(cases.rowCount, 1);
  assert.equal(cases.rows[0].urgency, 'critical');
  await sendMessage(id, requestId, crisisMessage, stub(routineProposal));
  assert.equal((await pool.query('SELECT 1 FROM turns WHERE conversation_id = $1', [id])).rowCount, 1);
  console.log('PASS crisis is saved as a critical case; a retry creates no duplicate');

  // Concurrency: two staff claim at the same instant.
  const caseId = cases.rows[0].id;
  const claims = await Promise.allSettled([claimCase(caseId, 'alex'), claimCase(caseId, 'bea')]);
  assert.equal(claims.filter(c => c.status === 'fulfilled').length, 1);
  assert.equal((claims.find(c => c.status === 'rejected') as PromiseRejectedResult).reason.status, 409);
  const owner = (await caseDetail(caseId)).claimed_by;
  const other = owner === 'alex' ? 'bea' : 'alex';
  await assert.rejects(resolveCase(caseId, other), (e: { status: number }) => e.status === 409);
  console.log('PASS simultaneous claims: one owner, one 409; only the owner can resolve');

  // A calm follow-up never downgrades the open case.
  await sendMessage(id, randomUUID(), 'Where are past papers?', stub(routineProposal));
  assert.equal((await caseDetail(caseId)).urgency, 'critical');
  await resolveCase(caseId, owner);
  console.log('PASS a routine follow-up does not lower a critical case');

  // Clarification context: the second message sees the assistant's question.
  const chat = randomUUID();
  await pool.query('INSERT INTO conversations (id, session_hash) VALUES ($1, $2)', [chat, randomUUID()]);
  await sendMessage(chat, randomUUID(), 'need help asap', stub({ ...routineProposal, category: 'other', disposition: 'clarify', reply: 'What do you need help with?', factIds: [] }));
  await sendMessage(chat, randomUUID(), 'past exam papers', async (_text, history) => {
    assert.ok(history.some(m => m.role === 'assistant' && m.text.includes('What do you need help with')));
    return { raw: routineProposal, providerStatus: 'fixture', attempts: 1 };
  });
  const saved = await transcript(chat);
  assert.deepEqual(saved.turns.map(t => t.disposition), ['clarify', 'handle_now']);
  const audit = await pool.query("SELECT decision->'audit'->>'providerStatus' AS status FROM turns WHERE conversation_id = $1", [chat]);
  assert.ok(audit.rows.every(r => r.status === 'fixture'));
  console.log('PASS clarification then answer, with the model audit stored on each turn');

  // Escalation without contact details asks for them.
  const escalated = await sendMessage(chat, randomUUID(), 'I want to report harassment', stub(routineProposal));
  assert.match(escalated.turn.reply ?? '', /name and email/);

  // An abandoned pending turn is recovered (escalated), never lost.
  const staleRequest = randomUUID();
  await pool.query("INSERT INTO turns (id, conversation_id, request_id, student_text, state, created_at) VALUES ($1, $2, $3, 'Need help', 'pending', now() - interval '60 seconds')", [randomUUID(), chat, staleRequest]);
  await sendMessage(chat, randomUUID(), 'hello again', stub(routineProposal));
  assert.equal((await pool.query('SELECT state FROM turns WHERE request_id = $1', [staleRequest])).rows[0].state, 'completed');
  console.log('PASS contact requested on escalation; abandoned turns are recovered');
}

/** Starts the built app on a free port against the test schema and checks auth + concurrent claims over HTTP. */
async function httpChecks(connectionString: string, schema: string) {
  const port = await new Promise<number>(resolve => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const base = `http://localhost:${port}`;
  const passwords = { alex: randomUUID(), bea: randomUUID() };
  const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--port', String(port)], {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: url.toString(), GEMINI_API_KEY: '', GEMINI_MODEL: '', STAFF_A_PASSWORD: passwords.alex, STAFF_B_PASSWORD: passwords.bea, SESSION_SECRET: randomUUID() + randomUUID() },
  });
  try {
    for (let i = 0; i < 60; i++) {
      try { await fetch(base, { signal: AbortSignal.timeout(1000) }); break; } catch { await new Promise(r => setTimeout(r, 250)); }
    }
    const call = (path: string, method = 'GET', body?: unknown, cookie = '', origin = base) =>
      fetch(base + path, { method, headers: { origin, cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const cookieOf = (response: Response) => response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');

    assert.equal((await call('/api/staff/cases')).status, 401);
    assert.equal((await call('/api/conversations', 'POST', undefined, '', 'https://evil.example')).status, 403);

    const student = cookieOf(await call('/api/conversations', 'POST'));
    assert.equal((await call('/api/conversations', 'PATCH', { name: 'HTTP Student', email: 'http@example.invalid' }, student)).status, 200);
    const sent = await (await call('/api/chat', 'POST', { text: crisisMessage, requestId: randomUUID() }, student)).json();
    assert.equal(sent.turn.emergency, true);

    const other = cookieOf(await call('/api/conversations', 'POST'));
    assert.equal((await (await call('/api/conversations', 'POST', undefined, other)).json()).turns.length, 0, 'sessions are isolated');

    const alex = cookieOf(await call('/api/staff/session', 'POST', { staffId: 'alex', password: passwords.alex }));
    const bea = cookieOf(await call('/api/staff/session', 'POST', { staffId: 'bea', password: passwords.bea }));
    const { cases } = await (await call('/api/staff/cases', 'GET', undefined, alex)).json();
    const item = cases.find((c: { email: string }) => c.email === 'http@example.invalid');
    const results = await Promise.all([alex, bea].map(cookie => call(`/api/staff/cases/${item.id}`, 'PATCH', { action: 'claim' }, cookie)));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    console.log('PASS over HTTP: auth required, origin checked, sessions isolated, concurrent claims 200/409');
  } finally {
    app.kill();
  }
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL first.');
  const schema = `welfare_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 5 });
    (globalThis as unknown as { welfarePool: Pool }).welfarePool = pool; // make the app code use the test schema
    await pool.query(await readFile('db/001-initial.sql', 'utf8'));
    await serviceChecks(pool);
    if (process.argv.includes('--http')) await httpChecks(process.env.DATABASE_URL, schema);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

run().catch(error => {
  console.error('Database checks failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
