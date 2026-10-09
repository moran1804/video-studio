'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@/lib/types';
import { apiGet, apiSend } from '@/lib/api';
import { formatDate, JOB_LABELS, PLATFORM_LABELS, relativeTime } from '@/lib/format';
import { Badge, Button, Card, EmptyState, ProgressBar, SectionTitle, useAction } from './ui';

export function Dashboard({ initial }: { initial: ProjectSummary[] }) {
  const [projects, setProjects] = useState(initial);
  const { busy, run } = useAction();
  const active = projects.some((p) => p.progress.active > 0);

  useEffect(() => {
    const t = setInterval(
      async () => {
        try {
          const r = await apiGet<{ projects: ProjectSummary[] }>('/api/projects');
          setProjects(r.projects);
        } catch {
          /* ignore transient errors */
        }
      },
      active ? 3000 : 15000,
    );
    return () => clearInterval(t);
  }, [active]);

  const failed = projects.flatMap((p) => p.failedJobs);

  const retry = (jobId: string) =>
    run(
      `retry-${jobId}`,
      async () => {
        await apiSend(`/api/jobs/${jobId}/retry`, 'POST');
        const r = await apiGet<{ projects: ProjectSummary[] }>('/api/projects');
        setProjects(r.projects);
      },
      'Job re-queued',
    );

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-white">
            Your <span className="gradient-text">studio</span>
          </h1>
          <p className="mt-1 text-sm text-studio-muted">
            Brief → storyboard → AI scenes → voice, music & captions → export.
          </p>
        </div>
        <Link href="/projects/new">
          <Button variant="primary" data-testid="new-project">
            + New project
          </Button>
        </Link>
      </div>

      {failed.length > 0 && (
        <Card className="mb-8 border-red-500/30 p-4">
          <SectionTitle
            title="Needs attention"
            subtitle="These jobs failed. Fix the cause (for example an API key or prompt), then retry."
          />
          <ul className="divide-y divide-studio-line">
            {failed.slice(0, 10).map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm text-white">
                    {JOB_LABELS[j.type] ?? j.type} ·{' '}
                    <Link className="underline decoration-dotted" href={`/projects/${j.projectId}`}>
                      {j.projectName}
                    </Link>
                  </div>
                  <div className="truncate text-xs text-red-300" title={j.error ?? ''}>
                    {j.error}
                  </div>
                </div>
                <Button size="sm" onClick={() => retry(j.id)} loading={busy === `retry-${j.id}`}>
                  Retry
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          action={
            <Link href="/projects/new">
              <Button variant="primary">Create your first video</Button>
            </Link>
          }
        >
          Start with a creative brief, add references you love and let the studio build a storyboard.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <Card
              key={p.id}
              data-testid="project-card"
              className="group overflow-hidden transition hover:border-studio-accent/60 hover:shadow-glow"
            >
              <Link href={`/projects/${p.id}`} className="block">
                <div className="relative aspect-video bg-gradient-to-br from-violet-900/40 via-studio-panel to-fuchsia-900/30">
                  {p.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.thumbnailUrl}
                      alt=""
                      className="h-full w-full object-cover opacity-90 transition group-hover:opacity-100"
                    />
                  ) : (
                    <div className="grid h-full place-items-center text-4xl text-white/10">▶</div>
                  )}
                  <div className="absolute left-3 top-3">
                    <Badge status={p.status.key}>{p.status.label}</Badge>
                  </div>
                  <div className="absolute bottom-3 right-3 rounded-md bg-black/60 px-2 py-0.5 text-[11px] text-zinc-200">
                    {p.aspectRatio} · {p.durationSec}s
                  </div>
                </div>
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="truncate font-display font-semibold text-white">{p.name}</h3>
                  </div>
                  <p className="mt-0.5 text-xs text-studio-muted">
                    {PLATFORM_LABELS[p.platform] ?? p.platform} · created {formatDate(p.createdAt)}
                  </p>
                  {p.progress.totalScenes > 0 && (
                    <div className="mt-3">
                      <div className="mb-1 flex justify-between text-[11px] text-studio-muted">
                        <span>Scenes</span>
                        <span>
                          {p.progress.completedScenes}/{p.progress.totalScenes}
                        </span>
                      </div>
                      <ProgressBar
                        value={p.progress.completedScenes / p.progress.totalScenes}
                        indeterminate={p.progress.active > 0 && p.progress.renderProgress === null}
                      />
                    </div>
                  )}
                  {p.progress.renderProgress !== null && (
                    <div className="mt-2">
                      <div className="mb-1 text-[11px] text-studio-muted">
                        Rendering {Math.round(p.progress.renderProgress * 100)}%
                      </div>
                      <ProgressBar value={p.progress.renderProgress} />
                    </div>
                  )}
                </div>
              </Link>
              <div className="px-4 pb-4">
                <div className="flex items-center justify-between border-t border-studio-line pt-3 text-xs">
                  {p.latestExport ? (
                    <a href={p.latestExport.downloadUrl} className="text-violet-300 hover:text-violet-200">
                      ⬇ Latest export · {relativeTime(p.latestExport.createdAt)}
                    </a>
                  ) : (
                    <span className="text-studio-muted">No export yet</span>
                  )}
                  {p.failedJobs.length > 0 && (
                    <span className="text-red-300">{p.failedJobs.length} failed</span>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
