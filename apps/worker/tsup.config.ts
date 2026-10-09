import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', migrate: 'src/migrate.ts', healthcheck: 'src/healthcheck.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle the workspace package; keep real dependencies external (installed in the image).
  noExternal: ['@studio/core'],
  // Runtime dependencies of @studio/core stay in node_modules (native modules cannot be bundled).
  external: [
    '@node-rs/argon2',
    'bullmq',
    'drizzle-orm',
    'file-type',
    'ioredis',
    'ipaddr.js',
    'pg',
    'pino',
    'undici',
    'zod',
  ],
  splitting: false,
});
