import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestProject, hasFfmpeg, hasInfra, setupTestEnv, teardownTestEnv } from '../integration/env';

/** End-to-end job pipeline with mock providers: storyboard → generation → voiceover → render. */
describe.skipIf(!hasFfmpeg || !hasInfra)('job pipeline (mock providers, real FFmpeg)', () => {
  beforeAll(async () => {
    await setupTestEnv();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  const run = async (type: string, ids: Record<string, string>, payload: Record<string, unknown> = {}) => {
    const { getDb } = await import('../../src/db');
    const { jobs } = await import('../../src/db/schema');
    const { runTracked } = await import('../../src/jobs/context');
    const { HANDLERS } = await import('../../src/jobs/registry');
    const [row] = await getDb()
      .insert(jobs)
      .values({ type, queue: 'x', payload, ...ids })
      .returning();
    const entry = HANDLERS[type as keyof typeof HANDLERS];
    await runTracked(
      { data: { jobId: row!.id }, attemptsMade: 0, opts: { attempts: 1 } },
      entry.handler,
      entry.onFailure,
    );
    const [done] = await getDb().select().from(jobs).where(eq(jobs.id, row!.id));
    return done!;
  };

  it('produces a final export', async () => {
    const { getDb } = await import('../../src/db');
    const { assets, projects, renders, scenes } = await import('../../src/db/schema');
    const { absPath } = await import('../../src/storage');
    const { probe } = await import('../../src/ffmpeg/probe');
    const project = await createTestProject({ durationSec: 8 });

    expect((await run('brief', { projectId: project.id })).status).toBe('completed');
    await getDb().update(projects).set({ briefStatus: 'approved' }).where(eq(projects.id, project.id));
    expect((await run('storyboard', { projectId: project.id })).status).toBe('completed');
    const list = await getDb()
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, project.id))
      .orderBy(asc(scenes.position));
    for (const s of list) {
      const job = await run('generation', { projectId: project.id, sceneId: s.id });
      expect(job.status, job.error ?? '').toBe('completed');
    }
    const generated = await getDb().select().from(scenes).where(eq(scenes.projectId, project.id));
    expect(generated.every((s) => s.status === 'completed' && s.clipAssetId)).toBe(true);

    expect((await run('voiceover', { projectId: project.id }, { mode: 'per-scene' })).status).toBe(
      'completed',
    );

    const [render] = await getDb()
      .insert(renders)
      .values({ projectId: project.id, mode: 'final', width: 1080, height: 1920 })
      .returning();
    const job = await run('render', { projectId: project.id, renderId: render!.id });
    expect(job.status, job.error ?? '').toBe('completed');
    const [done] = await getDb().select().from(renders).where(eq(renders.id, render!.id));
    expect(done).toMatchObject({ status: 'completed', progress: 1 });
    const [video] = await getDb().select().from(assets).where(eq(assets.id, done!.videoAssetId!));
    expect(video!.relPath).toMatch(new RegExp(`^projects/${project.id}/exports/`));
    const info = await probe(absPath(video!.relPath));
    expect(info.video).toMatchObject({ width: 1080, height: 1920, codec: 'h264' });
    expect(done!.srtAssetId).toBeTruthy();
  });

  it('fails a render cleanly when scenes have no footage', async () => {
    const { getDb } = await import('../../src/db');
    const { renders, scenes } = await import('../../src/db/schema');
    const project = await createTestProject();
    await getDb()
      .insert(scenes)
      .values({ projectId: project.id, position: 0, prompt: 'x', provider: 'mock' });
    const [render] = await getDb()
      .insert(renders)
      .values({ projectId: project.id, mode: 'preview', width: 540, height: 960 })
      .returning();
    const job = await run('render', { projectId: project.id, renderId: render!.id }).catch(async () => {
      const { jobs } = await import('../../src/db/schema');
      return (await getDb().select().from(jobs).where(eq(jobs.renderId, render!.id)))[0]!;
    });
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/without footage/);
    const [r] = await getDb().select().from(renders).where(eq(renders.id, render!.id));
    expect(r!.status).toBe('failed');
  });
});
