/**
 * GET   /api/staff/cases/:id: case detail plus the full conversation.
 * PATCH /api/staff/cases/:id { action: 'claim' | 'resolve' }: the acting staff member comes from the signed cookie.
 */
import { z } from 'zod';
import { checkOrigin, staffSession } from '../../../../../lib/auth';
import { api, HttpError, readJson } from '../../../../../lib/http';
import { caseDetail, claimCase, resolveCase } from '../../../../../lib/staff-service';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };
const action = z.object({ action: z.enum(['claim', 'resolve']) }).strict();

async function caseId(context: Context) {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new HttpError(400, 'Invalid case id.');
  return id;
}

export async function GET(_request: Request, context: Context) {
  return api(async () => {
    await staffSession();
    return caseDetail(await caseId(context));
  });
}

export async function PATCH(request: Request, context: Context) {
  return api(async () => {
    checkOrigin(request);
    const staffId = await staffSession();
    const id = await caseId(context);
    const { action: kind } = await readJson(request, action);
    return kind === 'claim' ? claimCase(id, staffId) : resolveCase(id, staffId);
  });
}
