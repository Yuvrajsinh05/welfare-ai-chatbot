/** Demo staff sign-in (GET = who am I, POST = sign in, DELETE = sign out). */
import { z } from 'zod';
import { checkOrigin, signInStaff, signOutStaff, staffSession } from '../../../../lib/auth';
import { api, readJson } from '../../../../lib/http';

export const runtime = 'nodejs';

const credentials = z.object({ staffId: z.enum(['alex', 'bea']), password: z.string().min(1).max(200) }).strict();

export async function GET() {
  return api(async () => ({ staffId: await staffSession() }));
}

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const { staffId, password } = await readJson(request, credentials);
    await signInStaff(staffId, password);
    return { staffId };
  });
}

export async function DELETE(request: Request) {
  return api(async () => {
    checkOrigin(request);
    await signOutStaff();
    return { signedOut: true };
  });
}
