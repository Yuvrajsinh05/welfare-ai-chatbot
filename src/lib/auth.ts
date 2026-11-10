/**
 * Sessions.
 * - Student: an anonymous random token in an HTTP-only cookie. The DB stores only its SHA-256 hash,
 *   so a database leak does not let anyone hijack a conversation.
 * - Staff: a signed (HMAC) cookie holding { id, expires }. The server never trusts an owner id sent by the browser.
 */
import { cookies } from 'next/headers';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { database } from './db';
import { HttpError } from './http';

export const STAFF = { alex: 'STAFF_A_PASSWORD', bea: 'STAFF_B_PASSWORD' } as const;
export type StaffId = keyof typeof STAFF;

const STUDENT_COOKIE = 'welfare_student';
const STAFF_COOKIE = 'welfare_staff';
const DAY = 60 * 60 * 24;
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/' };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** CSRF guard for state-changing requests: the browser's Origin must be this site. */
export function checkOrigin(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    throw new HttpError(403, 'This request must come from this application.');
  }
}

/** Returns the student's conversation id; with `create`, starts a new conversation if there is none. */
export async function studentSession(create = false): Promise<string> {
  const jar = await cookies();
  const token = jar.get(STUDENT_COOKIE)?.value;
  if (token) {
    const found = await database().query('SELECT id FROM conversations WHERE session_hash = $1', [sha256(token)]);
    if (found.rows[0]) return found.rows[0].id;
  }
  if (!create) throw new HttpError(401, 'Start a conversation first.');

  const newToken = randomBytes(32).toString('hex');
  const id = randomUUID();
  await database().query('INSERT INTO conversations (id, session_hash) VALUES ($1, $2)', [id, sha256(newToken)]);
  jar.set(STUDENT_COOKIE, newToken, { ...cookieOptions, maxAge: DAY });
  return id;
}

function sign(value: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new HttpError(503, 'Staff access needs SESSION_SECRET (32+ characters).');
  return createHmac('sha256', secret).update(value).digest('hex');
}

/** Constant-time comparison, so response timing does not reveal how much of a secret matched. */
function sameSecret(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export async function signInStaff(id: StaffId, password: string) {
  const expected = process.env[STAFF[id]];
  if (!expected) throw new HttpError(503, 'Staff passwords are not configured.');
  if (!sameSecret(expected, password)) throw new HttpError(401, 'Those staff details did not match.');
  const payload = Buffer.from(JSON.stringify({ id, expires: Date.now() + 8 * 3600_000 })).toString('base64url');
  (await cookies()).set(STAFF_COOKIE, `${payload}.${sign(payload)}`, { ...cookieOptions, maxAge: 8 * 3600 });
}

export async function signOutStaff() {
  (await cookies()).delete(STAFF_COOKIE);
}

/** Verifies the signature and expiry of the staff cookie and returns the staff id. */
export async function staffSession(): Promise<StaffId> {
  const token = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!token) throw new HttpError(401, 'Please sign in as a staff member.');
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !sameSecret(sign(payload), signature)) throw new HttpError(401, 'Please sign in again.');
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!Object.hasOwn(STAFF, data.id) ||!(data.expires > Date.now())) throw new Error('expired');
    return data.id;
  } catch {
    throw new HttpError(401, 'Please sign in again.');
  }
}
