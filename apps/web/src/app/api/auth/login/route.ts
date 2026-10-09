import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { users } from '@studio/core/db/schema';
import { hashPassword, verifyPassword } from '@studio/core/security/password';
import { randomToken } from '@studio/core/security/crypto';
import { UserFacingError } from '@studio/core/errors';
import { api, clientIp, parseJson } from '@/server/api';
import { getRedis } from '@studio/core/redis';
import { rateLimit } from '@studio/core/security/rate-limit';
import { createSession, SESSION_COOKIE, sessionCookieOptions } from '@/server/auth';

const schema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(500),
});
// A real hash for a random password, so unknown emails take as long as wrong passwords.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(randomToken(16)));

export const POST = api(
  async (req) => {
    const { email, password } = await parseJson(req, schema);
    // Limit attempts per client *and* account so one noisy client cannot lock out everyone
    // (without TRUST_PROXY all direct clients share one address bucket).
    const rl = await rateLimit(getRedis(), `login:${clientIp(req)}:${email}`, 10, 300);
    if (!rl.allowed) {
      throw new UserFacingError(
        `Too many sign-in attempts. Try again in ${rl.retryAfterSec}s.`,
        429,
        'rate_limited',
      );
    }
    const [user] = await getDb().select().from(users).where(eq(users.email, email));
    const ok = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), password);
    if (!user || !ok) throw new UserFacingError('Incorrect email or password.', 401, 'invalid_credentials');
    const { token, maxAgeSec } = await createSession(user.id);
    const res = NextResponse.json({ ok: true, email: user.email });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(maxAgeSec));
    return res;
  },
  { auth: false, rateLimit: { bucket: 'login-ip', limit: 60, windowSec: 300 } },
);
