import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, validateRuntimeConfig, ConfigError } from '@studio/core/config';
import { bootstrapAdmin, runMigrations } from '@studio/core/db/migrate';
import { closeDb } from '@studio/core/db';
import { ensureBaseLayout } from '@studio/core/storage';

/** One-shot container: apply migrations, create storage folders, bootstrap the admin. */
async function main() {
  process.env.SERVICE_NAME = 'migrate';
  let config;
  try {
    config = getConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
  const { errors, warnings } = validateRuntimeConfig('migrate', config);
  warnings.forEach((w) => console.warn(`[config] warning: ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.error(`[config] error: ${e}`));
    process.exit(1);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const folder = process.env.MIGRATIONS_DIR || path.resolve(here, '../../../packages/core/drizzle');
  await runMigrations(folder);
  await ensureBaseLayout();
  const admin = await bootstrapAdmin();
  console.warn(`[migrate] done (admin: ${admin})`);
  await closeDb();
}

main().catch((err) => {
  console.error(`[migrate] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
