import { NextResponse } from 'next/server';
import { getConfig } from '@studio/core/config';
import { randomToken } from '@studio/core/security/crypto';
import { api } from '@/server/api';
import { CSRF_COOKIE } from '@/server/auth';

/** Issues the double-submit CSRF cookie if the browser does not have one yet. */
export const GET = api(
  async (req) => {
    const existing = req.cookies.get(CSRF_COOKIE)?.value;
    const token = existing && existing.length >= 20 ? existing : randomToken(24);
    const res = NextResponse.json({ token });
    if (token !== existing) {
      res.cookies.set(CSRF_COOKIE, token, {
        httpOnly: false,
        sameSite: 'lax',
        secure: getConfig().secureCookies,
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
    }
    return res;
  },
  { auth: false },
);
