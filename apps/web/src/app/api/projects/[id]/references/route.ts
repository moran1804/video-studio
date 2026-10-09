import path from 'node:path';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { references } from '@studio/core/db/schema';
import { enqueueJob } from '@studio/core/queues';
import { createAsset } from '@studio/core/jobs/context';
import { REFERENCE_CATEGORIES } from '@studio/core/schemas';
import { CATEGORY_CLASSES, categoryForClass } from '@studio/core/security/upload';
import { validatePublicUrl } from '@studio/core/security/ssrf';
import { detectPlatform } from '@studio/core/providers/links';
import { UserFacingError } from '@studio/core/errors';
import { api, parseJson } from '@/server/api';
import { receiveUpload } from '@/server/upload';
import { getProjectBundle, getProjectOr404, touchProject } from '@/server/data';

const linkSchema = z.object({
  url: z.string().trim().min(8).max(2048),
  title: z.string().trim().max(300).default(''),
  notes: z.string().trim().max(2000).default(''),
  permissionConfirmed: z.literal(true, {
    message: 'Confirm that you own the content or have permission to use it.',
  }),
});

/** Add a reference: multipart upload (file) or JSON link. Analysis runs in the worker. */
export const POST = api<{ id: string }>(
  async (req, { params }) => {
    const project = await getProjectOr404(params.id);
    const db = getDb();
    const isMultipart = (req.headers.get('content-type') ?? '').startsWith('multipart/form-data');
    let refId: string;
    let skipAnalysis = false;

    if (isMultipart) {
      const { fields, file } = await receiveUpload(req, {
        allowed: CATEGORY_CLASSES.auto!,
        relDir: path.posix.join('projects', project.id, 'references'),
      });
      let category =
        fields.category && (REFERENCE_CATEGORIES as readonly string[]).includes(fields.category)
          ? fields.category
          : 'auto';
      if (category === 'auto' || category === 'link') category = categoryForClass(file.sniff.cls);
      const allowed = CATEGORY_CLASSES[category] ?? CATEGORY_CLASSES.auto!;
      if (!allowed.includes(file.sniff.cls)) category = categoryForClass(file.sniff.cls);
      // "Animate this image" only applies to images; the image becomes a scene's start frame.
      // "Copy this movement" applies to videos: the character performs the clip's motion.
      const usage =
        fields.usage === 'animate' && file.sniff.cls === 'image'
          ? 'animate'
          : fields.usage === 'motion' && file.sniff.cls === 'video'
            ? 'motion'
            : 'inspiration';
      if (usage === 'motion' && file.size > 100 * 1024 * 1024) {
        throw new UserFacingError('Movement videos must be 100 MB or smaller.');
      }
      if (usage === 'animate' && !['image', 'logo', 'poster', 'artwork'].includes(category))
        category = 'artwork';
      const asset = await createAsset({
        projectId: project.id,
        kind: 'reference',
        relPath: file.relPath,
        mime: file.sniff.mime,
        originalName: file.originalName,
      });
      const [ref] = await db
        .insert(references)
        .values({
          projectId: project.id,
          kind: 'upload',
          category,
          title: (fields.title ?? '').slice(0, 300) || file.originalName,
          notes: (fields.notes ?? '').slice(0, 2000),
          usage,
          assetId: asset.id,
          // Movement clips are only used for motion transfer, not style analysis.
          analysisStatus: usage === 'motion' ? 'none' : 'queued',
        })
        .returning();
      refId = ref!.id;
      skipAnalysis = usage === 'motion';
    } else {
      const input = await parseJson(req, linkSchema);
      let url: URL;
      try {
        url = validatePublicUrl(input.url);
      } catch (err) {
        throw new UserFacingError((err as Error).message);
      }
      const [ref] = await db
        .insert(references)
        .values({
          projectId: project.id,
          kind: 'link',
          category: 'link',
          title: input.title,
          notes: input.notes,
          sourceUrl: url.toString(),
          platform: detectPlatform(url),
          analysisStatus: 'queued',
        })
        .returning();
      refId = ref!.id;
    }
    if (!skipAnalysis) await enqueueJob({ type: 'analysis', projectId: project.id, referenceId: refId });
    await touchProject(project.id);
    return getProjectBundle(project.id);
  },
  { rateLimit: { bucket: 'upload', limit: 60, windowSec: 60 } },
);
