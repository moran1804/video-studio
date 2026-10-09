import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getConfig } from '@studio/core/config';
import { SESSION_COOKIE, userFromToken } from '@/server/auth';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  const jar = await cookies();
  const user = await userFromToken(jar.get(SESSION_COOKIE)?.value).catch(() => null);
  if (user) redirect('/');
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-lg font-bold text-white shadow-glow">
            ▶
          </div>
          <h1 className="font-display text-2xl font-bold text-white">{getConfig().APP_NAME}</h1>
          <p className="mt-1 text-sm text-studio-muted">Sign in to your private studio</p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
