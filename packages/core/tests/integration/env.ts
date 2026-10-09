import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sql } from 'drizzle-orm';

export const TEST_DB = process.env.TEST_DATABASE_URL;
export const TEST_REDIS = process.env.TEST_REDIS_URL;
export const hasInfra = Boolean(TEST_DB && TEST_REDIS);
export const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Point the app at the disposable test Postgres/Redis and a temp DATA_ROOT, then migrate + truncate. */
export async function setupTestEnv(): Promise<{ dataRoot: string }> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-data-'));
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB,
    REDIS_URL: `${TEST_REDIS}/5`,
    SESSION_SECRET: 'test-secret-'.padEnd(48, 'x'),
    DATA_ROOT: dataRoot,
    MOCK_PROVIDERS: 'true',
    AUTH_ENABLED: 'false',
    LOG_LEVEL: 'silent',
    GENERATION_POLL_SECONDS: '1',
  });
  const { resetConfigCache } = await import('../../src/config');
  resetConfigCache();
  const { runMigrations } = await import('../../src/db/migrate');
  await runMigrations(path.resolve(here, '../../drizzle'));
  const { getDb } = await import('../../src/db');
  await getDb().execute(
    sql`truncate table jobs, renders, scenes, "references", assets, projects, brands, app_settings, sessions, users restart identity cascade`,
  );
  const { getRedis } = await import('../../src/redis');
  await getRedis().flushdb();
  const { ensureBaseLayout } = await import('../../src/storage');
  await ensureBaseLayout();
  return { dataRoot };
}

export async function teardownTestEnv(): Promise<void> {
  const { closeQueues } = await import('../../src/queues');
  const { closeRedis } = await import('../../src/redis');
  const { closeDb } = await import('../../src/db');
  await closeQueues();
  await closeRedis();
  await closeDb();
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 30_000,
  intervalMs = 200,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function createTestProject(overrides: Record<string, unknown> = {}) {
  const { getDb } = await import('../../src/db');
  const { projects } = await import('../../src/db/schema');
  const s = await import('../../src/schemas');
  const { ensureProjectDirs } = await import('../../src/storage');
  const [p] = await getDb()
    .insert(projects)
    .values({
      name: 'Test project',
      platform: 'tiktok',
      aspectRatio: '9:16',
      durationSec: 12,
      details: s.projectDetailsSchema.parse({
        mainMessage: 'Summer rooftop party is back',
        callToAction: 'Get tickets',
      }),
      voiceSettings: { ...s.defaultVoiceSettings(), voiceId: 'mockvoice01' },
      audioSettings: s.defaultAudioSettings(),
      captionSettings: s.defaultCaptionSettings(),
      brandingSettings: s.defaultBrandingSettings(),
      ...overrides,
    })
    .returning();
  await ensureProjectDirs(p!.id);
  return p!;
}
