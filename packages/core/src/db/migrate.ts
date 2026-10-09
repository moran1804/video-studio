import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { getDb, getPool } from './index';
import { users } from './schema';
import { getConfig } from '../config';
import { hashPassword } from '../security/password';
import { getLogger } from '../logger';

const log = getLogger('migrate');

/** Wait until Postgres accepts connections (container start ordering). */
export async function waitForDatabase(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await getPool().query('select 1');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(`Database not reachable after ${timeoutMs / 1000}s: ${String(lastErr)}`);
}

export async function runMigrations(migrationsFolder: string): Promise<void> {
  await waitForDatabase();
  await migrate(getDb(), { migrationsFolder });
  log.info('database migrations applied');
}

/** Create the initial administrator from ADMIN_EMAIL / ADMIN_PASSWORD. */
export async function bootstrapAdmin(): Promise<'created' | 'reset' | 'exists' | 'skipped'> {
  const c = getConfig();
  if (!c.AUTH_ENABLED) return 'skipped';
  const db = getDb();
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  const email = c.ADMIN_EMAIL?.toLowerCase();
  if (count === 0) {
    if (!email || !c.ADMIN_PASSWORD) {
      throw new Error(
        'No users exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (min 10 characters) to create the first administrator.',
      );
    }
    await db
      .insert(users)
      .values({ email, passwordHash: await hashPassword(c.ADMIN_PASSWORD), isAdmin: true });
    log.info({ email }, 'administrator account created');
    return 'created';
  }
  if (c.ADMIN_RESET_PASSWORD && email && c.ADMIN_PASSWORD) {
    const existing = await db.select().from(users).where(eq(users.email, email));
    const hash = await hashPassword(c.ADMIN_PASSWORD);
    if (existing.length) await db.update(users).set({ passwordHash: hash }).where(eq(users.email, email));
    else await db.insert(users).values({ email, passwordHash: hash, isAdmin: true });
    log.warn({ email }, 'administrator password reset from environment (unset ADMIN_RESET_PASSWORD now)');
    return 'reset';
  }
  return 'exists';
}
