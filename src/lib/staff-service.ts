/**
 * Staff queue: listing, case detail, claiming and resolving.
 *
 * Claim safety: claiming is ONE conditional UPDATE. PostgreSQL row-locks the case, so when two staff
 * claim at the same instant the second UPDATE re-checks `status = 'new'` after the first commits,
 * matches 0 rows, and that person gets 409 "already claimed". Without the condition (read, then write),
 * both requests could read "new" and both believe they own the case.
 */
import { database, transaction } from './db';
import { HttpError } from './http';

export const CLAIM_SQL = `
  UPDATE cases SET claimed_by = $2, claimed_at = now(), status = 'in_progress', updated_at = now()
  WHERE id = $1 AND status = 'new' AND claimed_by IS NULL
  RETURNING *`;

/** Most important first: open before resolved, critical, safeguarding, then urgency, unclaimed, oldest. */
export async function listCases() {
  const { rows } = await database().query(`
    SELECT cases.*, conversations.name, conversations.email
    FROM cases JOIN conversations ON conversations.id = cases.conversation_id
    ORDER BY
      (status = 'resolved'),
      (urgency = 'critical') DESC,
      safeguarding DESC,
      CASE urgency WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
      (status = 'in_progress'),
      created_at`);
  return rows;
}

export async function caseDetail(id: string) {
  const found = await database().query(
    'SELECT cases.*, conversations.name, conversations.email FROM cases JOIN conversations ON conversations.id = cases.conversation_id WHERE cases.id = $1',
    [id],
  );
  if (!found.rows[0]) throw new HttpError(404, 'Case not found.');
  const turns = await database().query(`
    SELECT id, student_text, created_at,
           decision->>'reply' AS reply, decision->>'disposition' AS disposition,
           decision->>'urgency' AS urgency, decision->>'category' AS category, decision->>'reason' AS reason
    FROM turns WHERE conversation_id = $1 ORDER BY created_at, id`, [found.rows[0].conversation_id]);
  return { ...found.rows[0], turns: turns.rows };
}

export async function claimCase(id: string, staffId: string) {
  const claimed = await database().query(CLAIM_SQL, [id, staffId]);
  if (claimed.rows[0]) return claimed.rows[0];
  const current = await database().query('SELECT * FROM cases WHERE id = $1', [id]);
  if (!current.rows[0]) throw new HttpError(404, 'Case not found.');
  // Clicking "claim" twice yourself is not a conflict.
  if (current.rows[0].claimed_by === staffId && current.rows[0].status === 'in_progress') return current.rows[0];
  if (current.rows[0].status === 'resolved') throw new HttpError(409, 'This case has already been resolved.');
  throw new HttpError(409, `This case has already been claimed by ${current.rows[0].claimed_by}.`);
}

/** Only the owner can resolve. Locks the conversation so a new escalation can't race the resolution. */
export async function resolveCase(id: string, staffId: string) {
  return transaction(async client => {
    const found = await client.query('SELECT conversation_id FROM cases WHERE id = $1', [id]);
    if (!found.rows[0]) throw new HttpError(404, 'Case not found.');
    await client.query('SELECT id FROM conversations WHERE id = $1 FOR UPDATE', [found.rows[0].conversation_id]);
    const resolved = await client.query(
      "UPDATE cases SET status = 'resolved', updated_at = now() WHERE id = $1 AND status = 'in_progress' AND claimed_by = $2 RETURNING *",
      [id, staffId],
    );
    if (!resolved.rows[0]) throw new HttpError(409, 'Only the staff member who claimed this case can resolve it.');
    return resolved.rows[0];
  });
}
