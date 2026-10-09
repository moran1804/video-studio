import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestProject, hasFfmpeg, hasInfra, setupTestEnv, teardownTestEnv } from '../integration/env';
import { makePng } from '../fixtures/png';

/** Brand design system: generation from assets and use during video generation (mock AI, real FFmpeg). */
describe.skipIf(!hasFfmpeg || !hasInfra)('brand design system pipeline', () => {
  beforeAll(async () => {
    await setupTestEnv();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  const run = async (type: string, values: Record<string, unknown>) => {
    const { getDb } = await import('../../src/db');
    const { jobs } = await import('../../src/db/schema');
    const { runTracked } = await import('../../src/jobs/context');
    const { HANDLERS } = await import('../../src/jobs/registry');
    const [row] = await getDb()
      .insert(jobs)
      .values({ type, queue: 'x', ...values })
      .returning();
    const entry = HANDLERS[type as keyof typeof HANDLERS];
    await runTracked(
      { data: { jobId: row!.id }, attemptsMade: 0, opts: { attempts: 1 } },
      entry.handler,
      entry.onFailure,
    );
    return (await getDb().select().from(jobs).where(eq(jobs.id, row!.id)))[0]!;
  };

  it('generates a design system from assets and applies it to generation', async () => {
    const { getDb } = await import('../../src/db');
    const { brands, scenes } = await import('../../src/db/schema');
    const { createAsset } = await import('../../src/jobs/context');
    const { writeFileRel } = await import('../../src/storage');

    const [brand] = await getDb().insert(brands).values({ name: 'Trail Coffee' }).returning();
    const addImage = async (role: string, rgba: [number, number, number, number]) => {
      const rel = `brands/${brand!.id}/${role}-${Date.now()}.png`;
      await writeFileRel(rel, makePng(64, 64, rgba));
      return createAsset({
        brandId: brand!.id,
        kind: 'brand_asset',
        relPath: rel,
        mime: 'image/png',
        meta: { role, label: role },
      });
    };
    const logo = await addImage('logo-primary', [224, 96, 32, 255]);
    const product = await addImage('product', [32, 96, 64, 255]);
    await getDb().update(brands).set({ logoAssetId: logo.id }).where(eq(brands.id, brand!.id));

    const job = await run('brand', { payload: { brandId: brand!.id } });
    expect(job.status, job.error ?? '').toBe('completed');
    expect(job.result).toMatchObject({ images: 2 });
    const [withDs] = await getDb().select().from(brands).where(eq(brands.id, brand!.id));
    expect(withDs!.designStatus).toBe('draft');
    expect(withDs!.designSystem?.palette.length).toBeGreaterThan(0);
    expect(withDs!.designSystem?.promptKeywords).toContain('cinematic');

    // A scene without its own reference uses brand imagery and brand keywords.
    const project = await createTestProject({ brandId: brand!.id });
    const [scene] = await getDb()
      .insert(scenes)
      .values({
        projectId: project.id,
        position: 0,
        prompt: 'A hiker pours coffee',
        provider: 'mock',
        durationSec: 2,
      })
      .returning();
    const gen = await run('generation', { projectId: project.id, sceneId: scene!.id });
    expect(gen.status, gen.error ?? '').toBe('completed');
    expect(gen.result).toMatchObject({
      referenceSource: 'brand',
      referenceAssetId: product.id,
      brand: 'Trail Coffee',
    });
    expect(String(gen.result?.prompt)).toMatch(/Brand style – cinematic/);
    expect(String(gen.result?.negativePrompt)).toContain('dull colours');

    // Brief / storyboard context carries the guide.
    const { buildBriefContext } = await import('../../src/jobs/llm');
    const { ctx } = await buildBriefContext(project);
    expect(ctx.brand?.guide).toContain('Brand: Trail Coffee');
    expect(ctx.brand?.guide).toContain('Photography:');
  });

  it('builds a whole brand from "auto" uploads (create mode)', async () => {
    const { getDb } = await import('../../src/db');
    const { assets, brands } = await import('../../src/db/schema');
    const { createAsset } = await import('../../src/jobs/context');
    const { writeFileRel } = await import('../../src/storage');
    const [brand] = await getDb().insert(brands).values({ name: 'New brand' }).returning();
    for (const [i, rgba] of (
      [
        [250, 0, 120, 255],
        [20, 20, 30, 255],
      ] as const
    ).entries()) {
      const rel = `brands/${brand!.id}/upload-${i}.png`;
      await writeFileRel(rel, makePng(80, 80, [...rgba]));
      await createAsset({
        brandId: brand!.id,
        kind: 'brand_asset',
        relPath: rel,
        mime: 'image/png',
        meta: { role: 'auto' },
      });
    }
    const job = await run('brand', {
      payload: { brandId: brand!.id, mode: 'create', notes: 'student nights' },
    });
    expect(job.status, job.error ?? '').toBe('completed');
    expect(job.result).toMatchObject({ mode: 'create', classified: 2, named: 'Mock Brand Co' });

    const [b] = await getDb().select().from(brands).where(eq(brands.id, brand!.id));
    expect(b).toMatchObject({
      name: 'Mock Brand Co',
      designStatus: 'draft',
      defaultCta: 'Book now – link in bio',
    });
    expect(b!.handles).toMatchObject({ instagram: '@mockbrand' });
    const list = await getDb().select().from(assets).where(eq(assets.brandId, brand!.id));
    const roles = list.map((a) => a.meta?.role).sort();
    expect(roles).toEqual(['logo-primary', 'poster']);
    expect(b!.logoAssetId).toBe(list.find((a) => a.meta?.role === 'logo-primary')!.id);
    // The brand tokens follow the generated palette.
    expect(b!.primaryColor).toBe(b!.designSystem!.palette.find((p) => p.role === 'primary')!.hex);
  });
});
