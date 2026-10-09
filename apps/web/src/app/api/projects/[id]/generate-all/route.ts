import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { scenes } from '@studio/core/db/schema';
import { UserFacingError } from '@studio/core/errors';
import { api, parseJson } from '@/server/api';
import { getProjectOr404 } from '@/server/data';
import { activeJobFor, startGeneration } from '@/server/jobs';

/** Queue generation for every scene that still needs footage (or all scenes). */
export const POST = api<{ id: string }>(
  async (req, { params }) => {
    const project = await getProjectOr404(params.id);
    const { onlyMissing } = await parseJson(req, z.object({ onlyMissing: z.boolean().default(true) }));
    const list = await getDb()
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, project.id))
      .orderBy(asc(scenes.position));
    if (!list.length) throw new UserFacingError('Generate a storyboard first.');
    let queued = 0;
    const skipped: number[] = [];
    for (const s of list) {
      if (onlyMissing && s.clipAssetId && s.status === 'completed') continue;
      if (await activeJobFor({ sceneId: s.id, type: 'generation' })) {
        skipped.push(s.position + 1);
        continue;
      }
      await startGeneration(s);
      queued++;
    }
    return { queued, skipped };
  },
  { rateLimit: { bucket: 'generate', limit: 20, windowSec: 60 } },
);
