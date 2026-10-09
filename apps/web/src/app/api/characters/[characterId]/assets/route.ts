import path from 'node:path';
import { createAsset } from '@studio/core/jobs/context';
import { CHARACTER_UPLOAD_ROLE_IDS } from '@studio/core/schemas';
import { api } from '@/server/api';
import { receiveUpload } from '@/server/upload';
import { getCharacterDetail, getCharacterOr404 } from '@/server/characters';

/** Upload a turnaround sheet or reference image. role: sheet | face | body | expression | outfit | other | auto. */
export const POST = api<{ characterId: string }>(
  async (req, { params }) => {
    const c = await getCharacterOr404(params.characterId);
    const { fields, file } = await receiveUpload(req, {
      allowed: ['image'],
      relDir: path.posix.join('characters', c.id),
      maxBytes: 50 * 1024 * 1024,
    });
    const role = (CHARACTER_UPLOAD_ROLE_IDS as readonly string[]).includes(fields.role ?? '')
      ? fields.role!
      : 'auto';
    await createAsset({
      characterId: c.id,
      kind: 'character_upload',
      relPath: file.relPath,
      mime: file.sniff.mime,
      originalName: file.originalName,
      meta: { role },
    });
    return { character: await getCharacterDetail(c.id) };
  },
  { rateLimit: { bucket: 'upload', limit: 60, windowSec: 60 } },
);
