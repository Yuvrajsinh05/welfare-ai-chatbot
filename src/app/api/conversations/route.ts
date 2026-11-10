/**
 * POST  /api/conversations: start or restore the student's conversation (cookie-based) and return the transcript.
 * PATCH /api/conversations: save the student's name and email for follow-up. Never calls the model.
 */
import { z } from 'zod';
import { api, readJson } from '../../../lib/http';
import { checkOrigin, studentSession } from '../../../lib/auth';
import { transcript } from '../../../lib/conversation-service';
import { database } from '../../../lib/db';

export const runtime = 'nodejs';

const contact = z.object({ name: z.string().trim().min(1).max(100), email: z.email().max(254) }).strict();

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    return transcript(await studentSession(true));
  });
}

export async function PATCH(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const id = await studentSession();
    const { name, email } = await readJson(request, contact);
    await database().query('UPDATE conversations SET name = $2, email = $3 WHERE id = $1', [id, name, email]);
    return { saved: true };
  });
}
