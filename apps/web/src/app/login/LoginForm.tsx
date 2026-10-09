'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiSend } from '@/lib/api';
import { Button, Card, ErrorNote, Field, Input } from '@/components/ui';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Card className="p-6">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await apiSend('/api/auth/login', 'POST', { email, password });
            router.push('/');
            router.refresh();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Sign in failed');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            name="email"
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            name="password"
          />
        </Field>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Sign in
        </Button>
      </form>
    </Card>
  );
}
