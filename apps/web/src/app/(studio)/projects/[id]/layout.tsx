import { notFound } from 'next/navigation';
import { NotFoundError } from '@studio/core/errors';
import { getProjectBundle } from '@/server/data';
import { ProjectProvider } from '@/components/project/ProjectContext';
import { ProjectHeader } from '@/components/project/ProjectHeader';

export const dynamic = 'force-dynamic';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let bundle;
  try {
    bundle = await getProjectBundle(id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  return (
    <ProjectProvider initial={bundle}>
      <ProjectHeader />
      {children}
    </ProjectProvider>
  );
}
