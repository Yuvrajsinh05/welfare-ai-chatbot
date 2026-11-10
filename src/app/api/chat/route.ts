/**
 * POST /api/chat: send one student message and get the saved, policy-checked reply.
 * The conversation comes from the student's cookie, never from the request body.
 */
import { after } from 'next/server';
import { z } from 'zod';
import { api, readJson } from '../../../lib/http';
import { checkOrigin, studentSession } from '../../../lib/auth';
import { auditCrisisTurn, sendMessage } from '../../../lib/conversation-service';

export const runtime = 'nodejs';
export const maxDuration = 30; // two model attempts of up to 9s each, plus database work

const body = z.object({ text: z.string().trim().min(1).max(2000), requestId: z.uuid() }).strict();

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const { text, requestId } = await readJson(request, body);
    const conversationId = await studentSession();
    const { turn, needsAudit } = await sendMessage(conversationId, requestId, text);
    // Crisis turns were saved without waiting for the model; ask it afterwards, for the audit record only.
    if (needsAudit) after(() => auditCrisisTurn(turn.id, text).catch(() => {}));
    return { turn };
  });
}
