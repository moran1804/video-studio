import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq, gt, lt } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { sessions, users } from '@studio/core/db/schema';
import { getConfig } from '@studio/core/config';
import { randomToken, sha256 } from '@studio/core/security/crypto';
import { ensureInit } from './init';

export const SESSION_COOKIE = 'vs_session';
export const CSRF_COOKIE = 'vs_csrf';

export interface SessionUser {
  id: string;
  email: string;
  authDisabled?: boolean;
}

const LOCAL_USER: SessionUser = {
  id: '00000000-0000-4000-8000-000000000000',
  email: 'local',
  authDisabled: true,
};

export async function createSession(userId: string): Promise<{ token: string; maxAgeSec: number }> {
  const c = getConfig();
  const token = randomToken(32);
  const maxAgeSec = Math.round(c.SESSION_TTL_DAYS * 86400);
  await getDb()
    .insert(sessions)
    .values({ id: sha256(token), userId, expiresAt: new Date(Date.now() + maxAgeSec * 1000) });
  // Opportunistic cleanup of expired sessions.
  await getDb().delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return { token, maxAgeSec };
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await getDb()
    .delete(sessions)
    .where(eq(sessions.id, sha256(token)));
}

export async function userFromToken(token: string | undefined): Promise<SessionUser | null> {
  await ensureInit();
  if (!getConfig().AUTH_ENABLED) return LOCAL_USER;
  if (!token || token.length < 20 || token.length > 100) return null;
  const id = sha256(token);
  const rows = await getDb()
    .select({ userId: users.id, email: users.email, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())));
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > 3600_000) {
    await getDb().update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, id));
  }
  return { id: row.userId, email: row.email };
}

/** For server components / layouts: redirect to the login page when signed out. */
export async function requirePageUser(): Promise<SessionUser> {
  const jar = await cookies();
  const user = await userFromToken(jar.get(SESSION_COOKIE)?.value);
  if (!user) redirect('/login');
  return user;
}

export function sessionCookieOptions(maxAgeSec: number) {
  return {
    httpOnly: true,
    secure: getConfig().secureCookies,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSec,
  };
}
