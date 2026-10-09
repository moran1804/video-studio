import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { projects } from '@studio/core/db/schema';
import { enqueueJob } from '@studio/core/queues';
import { voiceSettingsSchema } from '@studio/core/schemas';
import { getTts } from '@studio/core/providers/registry';
import { getDefaults } from '@studio/core/settings';
import { UserFacingError } from '@studio/core/errors';
import { api, parseJson } from '@/server/api';
import { getProjectOr404 } from '@/server/data';
import { activeJobFor } from '@/server/jobs';

const schema = z.object({
  mode: z.enum(['full', 'per-scene']),
  sceneIds: z.array(z.string().uuid()).max(100).optional(),
});

/** Generate the complete voiceover, or per-scene voiceovers, without touching video. */
export const POST = api<{ id: string }>(
  async (req, { params }) => {
    const project = await getProjectOr404(params.id);
    const input = await parseJson(req, schema);
    if (await activeJobFor({ projectId: project.id, type: 'voiceover' }))
      throw new UserFacingError('A voiceover is already being generated.', 409, 'busy');
    const voice = voiceSettingsSchema.parse(project.voiceSettings ?? {});
    if (!voice.voiceId && !(await getDefaults()).voiceId) throw new UserFacingError('Choose a voice first.');
    await getTts();
    await getDb()
      .update(projects)
      .set({ voiceSettings: { ...voice, mode: input.mode }, updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    const job = await enqueueJob({
      type: 'voiceover',
      projectId: project.id,
      payload: { mode: input.mode, sceneIds: input.sceneIds },
    });
    return { jobId: job.id };
  },
  { rateLimit: { bucket: 'voiceover', limit: 20, windowSec: 60 } },
);
