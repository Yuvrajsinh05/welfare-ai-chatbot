/** API boundary helpers: a typed error, bounded JSON parsing and one consistent error response shape. */
import { z } from 'zod';

/** Thrown anywhere in the server; `api()` turns it into a JSON response with this status. */
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const MAX_BODY_BYTES = 16_000;

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, 'This message is too long. Please shorten it.');
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Send JSON data.'); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Please check the details and try again.');
  return parsed.data;
}

/** Runs a handler and returns JSON. Unknown errors become a generic 503 so internals never leak. */
export async function api(work: () => Promise<unknown>) {
  try {
    return Response.json(await work(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (!(error instanceof HttpError)) console.error('[api] unexpected error:', error instanceof Error ? error.message : 'unknown');
    const status = error instanceof HttpError ? error.status : 503;
    const message = error instanceof HttpError ? error.message : 'Something went wrong on our side. Your message is still in the box, please try again.';
    return Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}
