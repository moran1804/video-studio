import { eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { projects } from '@studio/core/db/schema';
import { UserFacingError } from '@studio/core/errors';
import { api } from '@/server/api';
import { getProjectBundle, getProjectOr404 } from '@/server/data';

export const POST = api<{ id: string }>(async (_req, { params }) => {
  const p = await getProjectOr404(params.id);
  if (!p.brief) throw new UserFacingError('Generate or write a brief first.');
  await getDb()
    .update(projects)
    .set({ briefStatus: 'approved', updatedAt: new Date() })
    .where(eq(projects.id, p.id));
  return getProjectBundle(p.id);
});
