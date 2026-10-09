import { loadProjectTimeline } from '@studio/core/jobs/caption-data';
import { toSrt } from '@studio/core/captions';
import { sanitizeFilename } from '@studio/core/security/paths';
import { api } from '@/server/api';
import { getProjectOr404 } from '@/server/data';

/** Caption cues for preview, or an SRT download with ?format=srt. */
export const GET = api<{ id: string }>(async (req, { params }) => {
  const project = await getProjectOr404(params.id);
  const data = await loadProjectTimeline(project);
  if (req.nextUrl.searchParams.get('format') === 'srt') {
    return new Response(toSrt(data.cues), {
      headers: {
        'content-type': 'application/x-subrip; charset=utf-8',
        'content-disposition': `attachment; filename="${sanitizeFilename(project.name, 'captions')}.srt"`,
      },
    });
  }
  return { cues: data.cues, overlays: data.overlays, timeline: data.timeline };
});
