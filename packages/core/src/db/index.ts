import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { getConfig } from '../config';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

const g = globalThis as unknown as { __studioDb?: { pool: pg.Pool; db: Db } };

export function getPool(): pg.Pool {
  return getDbBundle().pool;
}

export function getDb(): Db {
  return getDbBundle().db;
}

function getDbBundle() {
  if (!g.__studioDb) {
    const url = getConfig().DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not configured');
    const pool = new pg.Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', () => {
      /* idle client errors are logged by callers; prevent crash */
    });
    g.__studioDb = { pool, db: drizzle(pool, { schema }) };
  }
  return g.__studioDb;
}

export async function closeDb(): Promise<void> {
  if (g.__studioDb) {
    await g.__studioDb.pool.end();
    g.__studioDb = undefined;
  }
}

export { schema };
