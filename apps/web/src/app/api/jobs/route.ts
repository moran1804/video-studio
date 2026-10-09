import { desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { jobs, projects } from '@studio/core/db/schema';
import { JOB_STATUSES } from '@studio/core/schemas';
import { api } from '@/server/api';
import { jobDTO } from '@/server/data';

export const GET = api(async (req) => {
  const status = req.nextUrl.searchParams.get('status');
  const statuses =
    status && (JOB_STATUSES as readonly string[]).includes(status) ? [status] : [...JOB_STATUSES];
  const rows = await getDb()
    .select({ job: jobs, projectName: projects.name })
    .from(jobs)
    .leftJoin(projects, eq(projects.id, jobs.projectId))
    .where(inArray(jobs.status, statuses))
    .orderBy(desc(jobs.createdAt))
    .limit(200);
  return { jobs: rows.map((r) => jobDTO(r.job, r.projectName)) };
});
