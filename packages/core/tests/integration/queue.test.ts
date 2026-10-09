import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { createTestProject, hasInfra, setupTestEnv, teardownTestEnv, waitFor } from './env';

describe.skipIf(!hasInfra)('queue jobs (Postgres + Redis)', () => {
  let worker: Worker | undefined;

  beforeAll(async () => {
    await setupTestEnv();
    const { createRedis } = await import('../../src/redis');
    const { runTracked } = await import('../../src/jobs/context');
    const { HANDLERS } = await import('../../src/jobs/registry');
    worker = new Worker(
      'llm',
      async (job) => {
        const entry = HANDLERS[job.name as keyof typeof HANDLERS];
        await runTracked(job, entry.handler, entry.onFailure);
      },
      { connection: createRedis(), prefix: 'studio', concurrency: 2 },
    );
  });

  afterAll(async () => {
    await worker?.close();
    await teardownTestEnv();
  });

  it('generates a brief and a storyboard through BullMQ with mock providers', async () => {
    const { getDb } = await import('../../src/db');
    const { projects, scenes, jobs } = await import('../../src/db/schema');
    const { enqueueJob } = await import('../../src/queues');
    const project = await createTestProject();

    const briefJob = await enqueueJob({ type: 'brief', projectId: project.id });
    await waitFor(
      async () =>
        (await getDb().select().from(jobs).where(eq(jobs.id, briefJob.id)))[0]?.status === 'completed',
    );
    const [withBrief] = await getDb().select().from(projects).where(eq(projects.id, project.id));
    expect(withBrief!.briefStatus).toBe('draft');
    expect(withBrief!.brief?.concept).toContain('Summer rooftop party');

    await getDb().update(projects).set({ briefStatus: 'approved' }).where(eq(projects.id, project.id));
    const sbJob = await enqueueJob({ type: 'storyboard', projectId: project.id });
    await waitFor(
      async () => (await getDb().select().from(jobs).where(eq(jobs.id, sbJob.id)))[0]?.status === 'completed',
    );
    const rows = await getDb().select().from(scenes).where(eq(scenes.projectId, project.id));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((s) => s.provider === 'mock' && s.status === 'draft' && s.prompt.length > 0)).toBe(
      true,
    );
    expect(rows.map((r) => r.position).sort()).toEqual(rows.map((_, i) => i));
  });

  it('classifies retryable vs final failures and runs failure hooks', async () => {
    const { getDb } = await import('../../src/db');
    const { jobs } = await import('../../src/db/schema');
    const { runTracked } = await import('../../src/jobs/context');
    const { ProviderError, UserFacingError } = await import('../../src/errors');
    const project = await createTestProject();
    const [row] = await getDb()
      .insert(jobs)
      .values({ type: 'prompt', queue: 'llm', projectId: project.id })
      .returning();
    const fake = (attemptsMade: number) => ({
      data: { jobId: row!.id },
      attemptsMade,
      opts: { attempts: 3 },
    });
    const retryable = async () => {
      throw new ProviderError('temporary outage', { provider: 'x', retryable: true });
    };
    await expect(runTracked(fake(0), retryable)).rejects.toThrow('temporary outage');
    let [cur] = await getDb().select().from(jobs).where(eq(jobs.id, row!.id));
    expect(cur!.status).toBe('queued');
    expect(cur!.error).toMatch(/Attempt 1 of 3/);

    let hookMessage = '';
    await expect(runTracked(fake(2), retryable, async (_j, m) => void (hookMessage = m))).rejects.toThrow();
    [cur] = await getDb().select().from(jobs).where(eq(jobs.id, row!.id));
    expect(cur!.status).toBe('failed');
    expect(hookMessage).toBe('temporary outage');

    const [row2] = await getDb()
      .insert(jobs)
      .values({ type: 'prompt', queue: 'llm', projectId: project.id })
      .returning();
    await expect(
      runTracked({ data: { jobId: row2!.id }, attemptsMade: 0, opts: { attempts: 3 } }, async () => {
        throw new UserFacingError('bad input');
      }),
    ).rejects.toThrow('bad input');
    const [cur2] = await getDb().select().from(jobs).where(eq(jobs.id, row2!.id));
    expect(cur2!.status).toBe('failed');
  });

  it('stops quietly when a job is cancelled', async () => {
    const { getDb } = await import('../../src/db');
    const { jobs } = await import('../../src/db/schema');
    const { runTracked } = await import('../../src/jobs/context');
    const [row] = await getDb().insert(jobs).values({ type: 'prompt', queue: 'llm' }).returning();
    const run = runTracked(
      { data: { jobId: row!.id }, attemptsMade: 0, opts: { attempts: 1 } },
      async (ctx) => {
        for (let i = 0; i < 50; i++) {
          if (await ctx.isCancelled()) throw new Error('should be swallowed');
          await new Promise((r) => setTimeout(r, 100));
        }
      },
    );
    await new Promise((r) => setTimeout(r, 300));
    await getDb().update(jobs).set({ status: 'cancelled' }).where(eq(jobs.id, row!.id));
    await expect(run).resolves.toBeUndefined();
    const [cur] = await getDb().select().from(jobs).where(eq(jobs.id, row!.id));
    expect(cur!.status).toBe('cancelled');
  });

  it('recovers interrupted jobs after a restart', async () => {
    const { getDb } = await import('../../src/db');
    const { jobs, renders, scenes } = await import('../../src/db/schema');
    const { recoverJobs } = await import('../../src/jobs/recovery');
    const { getQueue } = await import('../../src/queues');
    const project = await createTestProject();
    const [scene] = await getDb()
      .insert(scenes)
      .values({ projectId: project.id, position: 0, prompt: 'x', provider: 'mock', status: 'generating' })
      .returning();
    const [render] = await getDb()
      .insert(renders)
      .values({ projectId: project.id, mode: 'final', status: 'running', width: 1080, height: 1920 })
      .returning();
    const [gen] = await getDb()
      .insert(jobs)
      .values({
        type: 'generation',
        queue: 'generation',
        projectId: project.id,
        sceneId: scene!.id,
        status: 'running',
        providerJobId: 'mock_abc',
        bullJobId: 'gone-1',
        provider: 'mock',
      })
      .returning();
    const [ren] = await getDb()
      .insert(jobs)
      .values({
        type: 'render',
        queue: 'render',
        projectId: project.id,
        renderId: render!.id,
        status: 'running',
        bullJobId: 'gone-2',
      })
      .returning();
    const [queued] = await getDb()
      .insert(jobs)
      .values({ type: 'brief', queue: 'llm', projectId: project.id, status: 'queued', bullJobId: 'gone-3' })
      .returning();

    const stats = await recoverJobs();
    expect(stats.resumed).toBeGreaterThanOrEqual(1);
    expect(stats.failed).toBeGreaterThanOrEqual(1);

    const [g] = await getDb().select().from(jobs).where(eq(jobs.id, gen!.id));
    expect(g).toMatchObject({ status: 'queued', providerJobId: 'mock_abc' });
    expect(g!.bullJobId).toBe(`${gen!.id}-2`);
    expect(await getQueue('generation').getJob(g!.bullJobId!)).toBeTruthy();

    const [r] = await getDb().select().from(jobs).where(eq(jobs.id, ren!.id));
    expect(r!.status).toBe('failed');
    expect(r!.error).toMatch(/restart/);
    const [rr] = await getDb().select().from(renders).where(eq(renders.id, render!.id));
    expect(rr!.status).toBe('failed');

    const [q] = await getDb().select().from(jobs).where(eq(jobs.id, queued!.id));
    expect(q!.status === 'queued' || q!.status === 'running' || q!.status === 'completed').toBe(true);
    await getQueue('generation').obliterate({ force: true });
  });
});
