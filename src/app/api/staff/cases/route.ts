/** GET /api/staff/cases: the priority-ordered queue. Staff sign-in required. */
import { staffSession } from '../../../../lib/auth';
import { api } from '../../../../lib/http';
import { listCases } from '../../../../lib/staff-service';

export const runtime = 'nodejs';

export async function GET() {
  return api(async () => {
    await staffSession();
    return { cases: await listCases() };
  });
}
