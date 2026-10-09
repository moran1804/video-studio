import { NextResponse } from 'next/server';
import { api } from '@/server/api';
import { destroySession, SESSION_COOKIE, sessionCookieOptions } from '@/server/auth';

export const POST = api(
  async (req) => {
    await destroySession(req.cookies.get(SESSION_COOKIE)?.value);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, '', { ...sessionCookieOptions(0), maxAge: 0 });
    return res;
  },
  { auth: false },
);
