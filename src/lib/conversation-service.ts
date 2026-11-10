/**
 * One chat turn, end to end:
 *   reserve the turn (short transaction) -> call the model (no transaction open) -> apply policy
 *   -> save the reply and, if escalated, the staff case (one transaction, so they are saved together or not at all).
 *
 * A crisis message skips the wait: its safe decision and critical case are committed BEFORE any model call.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { database, transaction } from './db';
import { HttpError } from './http';
import { applyPolicy, HANDOFF, HANDOFF_EXISTING } from './policy';
import { proposeReply, type HistoryMessage, type ModelFn } from './model';
import { severity, type Decision } from './triage-schema';
import { resourceCards } from './catalogue';
import { riskSignals } from './safety';

export const GREETING = 'Hi, I’m the student support assistant. Tell me what’s going on, in your own words, and we’ll work out the next step together. If it needs a person, I’ll make sure it gets to the right one.';
const CONTACT_ASK = 'So the team can reach you, please add your name and email in the “Your details” panel.';
/** A turn still pending after this long was abandoned (crash or timeout) and is recovered safely. */
const STALE_AFTER = "interval '45 seconds'";
const HISTORY_TURNS = 3;

export type StoredDecision = Decision & { audit?: { providerStatus: string; attempts: number; model?: string; proposal: unknown } };
type TurnRow = { id: string; student_text: string; decision: StoredDecision | null; state: string; created_at: string };

/** The shape the student's browser receives. Internal triage fields and the audit stay on the server. */
export function publicTurn(row: TurnRow) {
  return {
    id: row.id,
    text: row.student_text,
    reply: row.decision?.reply,
    disposition: row.decision?.disposition,
    emergency: row.decision?.possibleImmediateDanger ?? false,
    resources: resourceCards(row.decision?.factIds ?? []),
    state: row.state,
    createdAt: row.created_at,
  };
}
export type PublicTurn = ReturnType<typeof publicTurn>;

export async function transcript(conversationId: string) {
  const turns = await database().query('SELECT id, student_text, decision, state, created_at FROM turns WHERE conversation_id = $1 ORDER BY created_at, id', [conversationId]);
  const contact = await database().query('SELECT name, email FROM conversations WHERE id = $1', [conversationId]);
  return { greeting: GREETING, turns: turns.rows.map(publicTurn), contact: contact.rows[0] ?? {} };
}

/**
 * Creates the conversation's open case, or updates it. Urgency and safeguarding can only go UP:
 * a calmer follow-up message must never downgrade a serious case. Ownership is never touched here.
 */
async function upsertCase(client: PoolClient, conversationId: string, decision: Decision) {
  const open = await client.query("SELECT id, urgency, summary FROM cases WHERE conversation_id = $1 AND status <> 'resolved' FOR UPDATE", [conversationId]);
  const current = open.rows[0];
  if (!current) {
    await client.query(
      'INSERT INTO cases (id, conversation_id, category, urgency, safeguarding, summary) VALUES ($1, $2, $3, $4, $5, $6)',
      [randomUUID(), conversationId, decision.category, decision.urgency, decision.safeguarding, decision.summary],
    );
    return;
  }
  const moreSevere = severity(decision.urgency) > severity(current.urgency);
  // Newest first, tagged with its urgency, so a new emergency is the first line staff read.
  const summary = `[${decision.urgency.toUpperCase()}] ${decision.summary}\n— Earlier: ${current.summary}`.slice(0, 1500);
  await client.query(
    `UPDATE cases SET urgency = $2, safeguarding = safeguarding OR $3, summary = $4,
       category = CASE WHEN $5 THEN $6 ELSE category END, updated_at = now() WHERE id = $1`,
    [current.id, moreSevere ? decision.urgency : current.urgency, decision.safeguarding, summary, moreSevere, decision.category],
  );
}

/** Finishes a pending turn and, for escalations, updates the case, in the caller's transaction. */
async function completeTurn(client: PoolClient, conversationId: string, turnId: string, decision: StoredDecision) {
  const updated = await client.query(
    "UPDATE turns SET state = 'completed', decision = $2, completed_at = now() WHERE id = $1 AND state = 'pending' RETURNING id",
    [turnId, JSON.stringify(decision)],
  );
  if (updated.rowCount && decision.disposition === 'escalate') await upsertCase(client, conversationId, decision);
}

async function hasOpenCase(conversationId: string) {
  const { rowCount } = await database().query("SELECT 1 FROM cases WHERE conversation_id = $1 AND status <> 'resolved'", [conversationId]);
  return Boolean(rowCount);
}

async function hasContact(conversationId: string) {
  const { rows } = await database().query('SELECT name, email FROM conversations WHERE id = $1', [conversationId]);
  return Boolean(rows[0]?.name && rows[0]?.email);
}

export async function sendMessage(conversationId: string, requestId: string, text: string, model: ModelFn = proposeReply) {
  const danger = riskSignals(text).danger;

  // --- Step 1: reserve the turn. The row lock on the conversation serialises turns for one student.
  const reserved = await transaction(async client => {
    await client.query('SELECT id FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);

    // Recover a turn abandoned by a crashed or timed-out request: it is escalated, never silently lost.
    const stale = await client.query(`SELECT id, student_text FROM turns WHERE conversation_id = $1 AND state = 'pending' AND created_at < now() - ${STALE_AFTER}`, [conversationId]);
    for (const row of stale.rows) await completeTurn(client, conversationId, row.id, applyPolicy(row.student_text, null));

    // Same requestId = the browser retrying after a dropped connection: return the saved result.
    const prior = await client.query('SELECT * FROM turns WHERE conversation_id = $1 AND request_id = $2', [conversationId, requestId]);
    if (prior.rows[0]) {
      if (prior.rows[0].student_text !== text) throw new HttpError(409, 'This request id was already used for a different message.');
      if (prior.rows[0].state === 'pending') throw new HttpError(409, 'Your previous message is still being answered. Please try again in a moment.');
      return { row: prior.rows[0] as TurnRow, isNew: false, needsAudit: false };
    }

    // Crisis: commit the safe decision and the critical case now, even if another reply is still in flight.
    if (danger) {
      const decision = applyPolicy(text, null);
      const contact = await client.query('SELECT name, email FROM conversations WHERE id = $1', [conversationId]);
      if (!contact.rows[0]?.name || !contact.rows[0]?.email) decision.reply += `\n\n${CONTACT_ASK}`;
      const id = randomUUID();
      await client.query("INSERT INTO turns (id, conversation_id, request_id, student_text, state, decision, completed_at) VALUES ($1, $2, $3, $4, 'completed', $5, now())", [id, conversationId, requestId, text, JSON.stringify(decision)]);
      await upsertCase(client, conversationId, decision);
      return { row: { id, student_text: text, decision, state: 'completed', created_at: new Date().toISOString() }, isNew: false, needsAudit: true };
    }

    const pending = await client.query("SELECT 1 FROM turns WHERE conversation_id = $1 AND state = 'pending'", [conversationId]);
    if (pending.rowCount) throw new HttpError(409, 'Your previous message is still being answered. Please try again in a moment.');
    const inserted = await client.query("INSERT INTO turns (id, conversation_id, request_id, student_text, state) VALUES ($1, $2, $3, $4, 'pending') RETURNING *", [randomUUID(), conversationId, requestId, text]);
    return { row: inserted.rows[0] as TurnRow, isNew: true, needsAudit: false };
  });

  if (!reserved.isNew) return { turn: publicTurn(reserved.row), needsAudit: reserved.needsAudit };

  // --- Step 2: context for the model: the last few completed turns.
  const previous = await database().query(
    "SELECT student_text, decision FROM turns WHERE conversation_id = $1 AND state = 'completed' ORDER BY created_at DESC, id DESC LIMIT $2",
    [conversationId, HISTORY_TURNS],
  );
  const recent = previous.rows.reverse();
  const history: HistoryMessage[] = recent.flatMap(row => [
    { role: 'user' as const, text: row.student_text },
    { role: 'assistant' as const, text: row.decision?.reply ?? '' },
  ]);
  // Count only the clarifications in a row, so an earlier, unrelated question doesn't use up this topic's limit.
  let clarificationCount = 0;
  for (const row of [...recent].reverse()) {
    if (row.decision?.disposition !== 'clarify') break;
    clarificationCount++;
  }

  // --- Step 3: the model proposes, the policy decides. No transaction is open during this slow call.
  const result = await model(text, history);
  const decision: StoredDecision = {
    ...applyPolicy(text, result.raw, clarificationCount),
    audit: { providerStatus: result.providerStatus, attempts: result.attempts, model: result.model, proposal: result.raw },
  };
  if (decision.disposition === 'escalate') {
    // Don't announce a brand-new handoff on every message: say it joined the request staff already have.
    if (await hasOpenCase(conversationId)) decision.reply = decision.reply.replace(HANDOFF, HANDOFF_EXISTING);
    if (!(await hasContact(conversationId))) decision.reply += `\n\n${CONTACT_ASK}`;
  }

  // --- Step 4: save the reply and any case together.
  await transaction(client => completeTurn(client, conversationId, reserved.row.id, decision));
  const saved = await database().query('SELECT * FROM turns WHERE id = $1', [reserved.row.id]);
  return { turn: publicTurn(saved.rows[0]), needsAudit: false };
}

/**
 * Runs after the crisis response has been sent: records what the model would have said, for audit.
 * It can never change the committed decision or the case.
 */
export async function auditCrisisTurn(turnId: string, text: string, model: ModelFn = proposeReply) {
  const result = await model(text, []);
  const audit = { providerStatus: result.providerStatus, attempts: result.attempts, model: result.model, proposal: result.raw };
  await database().query("UPDATE turns SET decision = jsonb_set(decision, '{audit}', $2::jsonb) WHERE id = $1", [turnId, JSON.stringify(audit)]);
}
