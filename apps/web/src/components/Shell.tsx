'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import clsx from 'clsx';
import { apiSend } from '@/lib/api';
import { ToastProvider } from './ui';

const NAV = [
  { href: '/', label: 'Create', icon: '✦' },
  { href: '/characters', label: 'Characters', icon: '☺' },
  { href: '/characters/new', label: 'New character', icon: '+' },
  { href: '/brands', label: 'Brand profiles', icon: '◆' },
  { href: '/brands/new', label: 'New brand', icon: '+' },
  { href: '/projects', label: 'Advanced projects', icon: '▦' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

export function Shell({
  children,
  email,
  authDisabled,
  appName,
}: {
  children: React.ReactNode;
  email: string;
  authDisabled: boolean;
  appName: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The most specific matching menu item wins (so /brands/new highlights "New brand", not "Brand profiles").
  const activeHref = NAV.map((n) => n.href)
    .filter((h) => (h === '/' ? pathname === '/' : pathname === h || pathname.startsWith(`${h}/`)))
    .sort((a, b) => b.length - a.length)[0];
  const isActive = (href: string) => href === activeHref;

  const signOut = async () => {
    await apiSend('/api/auth/logout', 'POST').catch(() => undefined);
    router.push('/login');
    router.refresh();
  };

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          onClick={() => setOpen(false)}
          className={clsx(
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition',
            isActive(n.href) ? 'bg-white/10 text-white' : 'text-zinc-400 hover:bg-white/5 hover:text-white',
          )}
        >
          <span className="w-4 text-center text-studio-accent">{n.icon}</span>
          {n.label}
        </Link>
      ))}
    </nav>
  );

  return (
    <ToastProvider>
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-studio-line bg-studio-panel/70 p-4 backdrop-blur lg:flex">
          <Link href="/" className="mb-6 flex items-center gap-2 px-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 font-bold text-white">
              ▶
            </span>
            <span className="font-display text-sm font-bold leading-tight text-white">{appName}</span>
          </Link>
          {nav}
          <div className="mt-auto border-t border-studio-line pt-4 text-xs text-studio-muted">
            <div className="truncate px-2">{authDisabled ? 'Authentication disabled' : email}</div>
            {!authDisabled && (
              <button
                onClick={signOut}
                className="mt-2 w-full rounded-lg px-2 py-1.5 text-left text-zinc-300 hover:bg-white/5"
              >
                Sign out
              </button>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex items-center justify-between border-b border-studio-line bg-studio-bg/80 px-4 py-3 backdrop-blur lg:hidden">
            <Link href="/" className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-xs font-bold text-white">
                ▶
              </span>
              <span className="font-display text-sm font-bold text-white">{appName}</span>
            </Link>
            <button
              aria-label="Menu"
              className="rounded-lg border border-studio-line px-3 py-1.5 text-sm"
              onClick={() => setOpen((o) => !o)}
            >
              ☰
            </button>
          </header>
          {open && (
            <div className="border-b border-studio-line bg-studio-panel p-4 lg:hidden">
              {nav}
              {!authDisabled && (
                <button
                  onClick={signOut}
                  className="mt-3 w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-300 hover:bg-white/5"
                >
                  Sign out
                </button>
              )}
            </div>
          )}
          {authDisabled && (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-center text-xs text-amber-200">
              Authentication is disabled (AUTH_ENABLED=false). Only use this on a trusted network.
            </div>
          )}
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
