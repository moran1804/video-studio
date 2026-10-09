import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { runFfmpeg } from '../../src/ffmpeg/exec';
import { probe } from '../../src/ffmpeg/probe';
import { prepareStartFrame } from '../../src/ffmpeg/analyze';
import { MockVideoProvider } from '../../src/providers/video/mock';
import { makePng } from '../fixtures/png';
import { createTestProject, hasFfmpeg, hasInfra, setupTestEnv, teardownTestEnv } from '../integration/env';

/** Average RGB of the centre 8×8 pixels of a frame. */
async function centreColour(file: string, atSec = 0): Promise<[number, number, number]> {
  const { stdout } = await runFfmpeg(
    [
      ...(atSec > 0 ? ['-ss', String(atSec)] : []),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      'crop=iw/8:ih/8,scale=8:8',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { captureStdout: true },
  );
  const sum = [0, 0, 0];
  for (let i = 0; i < stdout.length; i += 3) for (let c = 0; c < 3; c++) sum[c]! += stdout[i + c]!;
  const n = stdout.length / 3;
  return [Math.round(sum[0]! / n), Math.round(sum[1]! / n), Math.round(sum[2]! / n)];
}

describe.skipIf(!hasFfmpeg)('animate an uploaded image', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'animate-'));
    // A landscape "poster": orange, so letterboxing into 9:16 is required.
    await fs.writeFile(path.join(dir, 'poster.png'), makePng(400, 200, [240, 120, 20, 255]));
  });

  it('fits the whole image into the start frame without cropping', async () => {
    const out = path.join(dir, 'frame.jpg');
    await prepareStartFrame(path.join(dir, 'poster.png'), out, 720, 1280);
    const info = await probe(out);
    expect(info.video).toMatchObject({ width: 720, height: 1280 });
    const [r, g, b] = await centreColour(out);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(90);
    expect(b).toBeLessThan(60);
  });

  it('mock provider animates the image itself', async () => {
    const frame = path.join(dir, 'frame.jpg');
    const provider = new MockVideoProvider({ delayMs: 0, imageCacheDir: path.join(dir, 'cache') });
    const job = await provider.createVideo({
      prompt: 'animate',
      aspectRatio: '9:16',
      durationSec: 2,
      referenceImage: { data: await fs.readFile(frame), mimeType: 'image/jpeg' },
    });
    const video = await provider.downloadResult(job.providerJobId);
    const clip = path.join(dir, 'clip.mp4');
    await fs.writeFile(clip, video.data);
    const info = await probe(clip);
    expect(info.video).toMatchObject({ width: 720, height: 1280 });
    expect(info.durationSec).toBeGreaterThan(1.8);
    const [r, , b] = await centreColour(clip, 1);
    expect(r).toBeGreaterThan(180); // the poster, not the test pattern
    expect(b).toBeLessThan(90);
  });
});

describe.skipIf(!hasFfmpeg || !hasInfra)('animate scene generation job', () => {
  beforeAll(async () => {
    await setupTestEnv();
  });
  afterAll(async () => {
    await teardownTestEnv();
  });

  it('uses the image as the start frame with layout-preserving prompt', async () => {
    const { getDb } = await import('../../src/db');
    const { jobs, scenes } = await import('../../src/db/schema');
    const { createAsset, runTracked } = await import('../../src/jobs/context');
    const { HANDLERS } = await import('../../src/jobs/registry');
    const { writeFileRel } = await import('../../src/storage');
    const project = await createTestProject();
    const rel = `projects/${project.id}/references/poster.png`;
    await writeFileRel(rel, makePng(300, 400, [30, 60, 220, 255]));
    const asset = await createAsset({
      projectId: project.id,
      kind: 'reference',
      relPath: rel,
      mime: 'image/png',
    });
    const [scene] = await getDb()
      .insert(scenes)
      .values({
        projectId: project.id,
        position: 0,
        prompt: 'Neon lights flicker',
        provider: 'mock',
        durationSec: 2,
        animateAssetId: asset.id,
      })
      .returning();
    const [row] = await getDb()
      .insert(jobs)
      .values({ type: 'generation', queue: 'generation', projectId: project.id, sceneId: scene!.id })
      .returning();
    await runTracked(
      { data: { jobId: row!.id }, attemptsMade: 0, opts: { attempts: 1 } },
      HANDLERS.generation.handler,
      HANDLERS.generation.onFailure,
    );
    const [done] = await getDb().select().from(jobs).where(eq(jobs.id, row!.id));
    expect(done!.status, done!.error ?? '').toBe('completed');
    expect(done!.result).toMatchObject({
      referenceSource: 'animate',
      referenceAssetId: asset.id,
      usedReferenceImage: true,
    });
    expect(String(done!.result?.prompt)).toMatch(/^Animate the provided image\. Keep all text/);
  });
});
