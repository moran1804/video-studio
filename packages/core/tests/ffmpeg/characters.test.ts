import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestProject, hasFfmpeg, hasInfra, setupTestEnv, teardownTestEnv } from '../integration/env';
import { makePng } from '../fixtures/png';

/** Virtual characters: references, keyframes and motion transfer (mock AI, real FFmpeg). */
describe.skipIf(!hasFfmpeg || !hasInfra)('virtual character pipeline', () => {
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

  let characterId = '';

  it('turns turnaround sheets into an identity description and clean references', async () => {
    const { getDb } = await import('../../src/db');
    const { assets, characters } = await import('../../src/db/schema');
    const { createAsset } = await import('../../src/jobs/context');
    const { writeFileRel } = await import('../../src/storage');
    const [c] = await getDb().insert(characters).values({ name: 'Maya', consent: true }).returning();
    characterId = c!.id;
    for (const [i, rgba] of (
      [
        [200, 120, 90, 255],
        [60, 90, 140, 255],
      ] as const
    ).entries()) {
      const rel = `characters/${c!.id}/sheet-${i}.png`;
      await writeFileRel(rel, makePng(120, 80, [...rgba]));
      await createAsset({
        characterId: c!.id,
        kind: 'character_upload',
        relPath: rel,
        mime: 'image/png',
        meta: { role: 'auto' },
      });
    }
    const job = await run('character', { payload: { characterId, mode: 'prepare' } });
    expect(job.status, job.error ?? '').toBe('completed');
    const [after] = await getDb().select().from(characters).where(eq(characters.id, characterId));
    expect(after!.status).toBe('review');
    expect(after!.description).toMatch(/mock description/);
    const list = await getDb().select().from(assets).where(eq(assets.characterId, characterId));
    const refs = list
      .filter((a) => a.kind === 'character_ref')
      .map((a) => a.meta?.role)
      .sort();
    expect(refs).toEqual(['ref-body', 'ref-face']);
    const uploads = list
      .filter((a) => a.kind === 'character_upload')
      .map((a) => a.meta?.role)
      .sort();
    expect(uploads).toEqual(['face', 'sheet']);

    // Regenerating one reference replaces it rather than adding another.
    const again = await run('character', { payload: { characterId, mode: 'ref', role: 'ref-face' } });
    expect(again.status, again.error ?? '').toBe('completed');
    const faces = (await getDb().select().from(assets).where(eq(assets.characterId, characterId))).filter(
      (a) => a.kind === 'character_ref' && a.meta?.role === 'ref-face',
    );
    expect(faces).toHaveLength(1);

    const shot = await run('character', {
      payload: { characterId, mode: 'test', scene: 'on a beach', look: 'ugc' },
    });
    expect(shot.status, shot.error ?? '').toBe('completed');
    expect(shot.result).toHaveProperty('testShot');
  });

  it('makes a keyframe and an identity-locked clip for a character scene', async () => {
    const { getDb } = await import('../../src/db');
    const { scenes } = await import('../../src/db/schema');
    const project = await createTestProject();
    const [scene] = await getDb()
      .insert(scenes)
      .values({
        projectId: project.id,
        position: 0,
        prompt: 'Jogging along the seafront',
        provider: 'mock',
        durationSec: 2,
        characterIds: [characterId],
        look: 'ugc',
      })
      .returning();
    const job = await run('generation', { projectId: project.id, sceneId: scene!.id });
    expect(job.status, job.error ?? '').toBe('completed');
    expect(job.result).toMatchObject({ referenceSource: 'keyframe', characters: ['Maya'], motion: false });
    expect((job.result as { characterReferences: number }).characterReferences).toBeGreaterThan(0);
    expect(String((job.result as { prompt: string }).prompt)).toMatch(
      /^The same person in every shot – .*Jogging along the seafront.*Nobody speaks/,
    );
    const [after] = await getDb().select().from(scenes).where(eq(scenes.id, scene!.id));
    expect(after!.keyframeAssetId).toBeTruthy();
    expect(after!.clipAssetId).toBeTruthy();

    // A retry reuses the stored keyframe.
    await getDb().update(scenes).set({ clipAssetId: null, status: 'draft' }).where(eq(scenes.id, scene!.id));
    const retry = await run('generation', { projectId: project.id, sceneId: scene!.id });
    expect((retry.result as { keyframeAssetId: string }).keyframeAssetId).toBe(after!.keyframeAssetId);
  });

  it('copies movement from a video (motion transfer)', async () => {
    const { getDb } = await import('../../src/db');
    const { scenes } = await import('../../src/db/schema');
    const { createAsset } = await import('../../src/jobs/context');
    const { runFfmpeg } = await import('../../src/ffmpeg/exec');
    const { absPath, ensureProjectDirs } = await import('../../src/storage');
    const { probe } = await import('../../src/ffmpeg/probe');
    const project = await createTestProject();
    await ensureProjectDirs(project.id);
    const rel = `projects/${project.id}/references/dance.mp4`;
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=360x640:r=30:d=4',
      '-pix_fmt',
      'yuv420p',
      '-y',
      absPath(rel),
    ]);
    const clip = await createAsset({
      projectId: project.id,
      kind: 'reference',
      relPath: rel,
      mime: 'video/mp4',
      durationSec: 4,
    });
    const [scene] = await getDb()
      .insert(scenes)
      .values({
        projectId: project.id,
        position: 0,
        prompt: 'Neon rooftop',
        provider: 'veo',
        durationSec: 4,
        characterIds: [characterId],
        motionAssetId: clip.id,
      })
      .returning();
    const job = await run('generation', { projectId: project.id, sceneId: scene!.id });
    expect(job.status, job.error ?? '').toBe('completed');
    expect(job.result).toMatchObject({ motion: true, referenceSource: 'keyframe' });
    expect(job.provider).toBe('kling');
    const [after] = await getDb().select().from(scenes).where(eq(scenes.id, scene!.id));
    const { getAsset } = await import('../../src/jobs/context');
    const out = await getAsset(after!.clipAssetId);
    expect((await probe(absPath(out!.relPath))).durationSec).toBeGreaterThan(3.5);
  });
});
