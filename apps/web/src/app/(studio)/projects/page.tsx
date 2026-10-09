import { listProjectSummaries } from '@/server/data';
import { Dashboard } from '@/components/Dashboard';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const projects = await listProjectSummaries();
  return <Dashboard initial={projects} />;
}
