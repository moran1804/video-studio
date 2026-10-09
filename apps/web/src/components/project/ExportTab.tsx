'use client';

import { apiSend } from '@/lib/api';
import type { ProjectBundle } from '@/lib/types';
import { formatBytes, formatDate, formatDuration } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  ErrorNote,
  ProgressBar,
  SectionTitle,
  useAction,
} from '../ui';
import { useProject } from './ProjectContext';

export function ExportTab() {
  const { bundle, setBundle } = useProject();
  const p = bundle.project;
  const { busy, run } = useAction();
  const missing = bundle.scenes.filter((s) => !s.clip);
  const activeRender = bundle.renders.find((r) => r.status === 'queued' || r.status === 'running');
  const canRender = bundle.scenes.length > 0 && missing.length === 0 && !activeRender;
  const latest = bundle.renders.find((r) => r.status === 'completed');

  const render = (mode: 'preview' | 'final') =>
    run(
      mode,
      async () => setBundle(await apiSend<ProjectBundle>(`/api/projects/${p.id}/renders`, 'POST', { mode })),
      mode === 'final' ? 'Final render queued' : 'Preview render queued',
    );

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <SectionTitle
          title="Render"
          subtitle="Preview renders are fast, half-resolution checks. The final export is H.264/AAC, 30 fps, yuv420p with fast start."
          actions={
            <>
              <Button
                onClick={() => render('preview')}
                disabled={!canRender}
                loading={busy === 'preview'}
                data-testid="render-preview"
              >
                Render preview
              </Button>
              <Button
                variant="primary"
                onClick={() => render('final')}
                disabled={!canRender}
                loading={busy === 'final'}
                data-testid="render-final"
              >
                Export final video
              </Button>
            </>
          }
        />
        {bundle.scenes.length === 0 && <ErrorNote>Create a storyboard and generate scenes first.</ErrorNote>}
        {missing.length > 0 && bundle.scenes.length > 0 && (
          <ErrorNote>Scenes {missing.map((s) => s.position + 1).join(', ')} have no footage yet.</ErrorNote>
        )}
        {activeRender && (
          <div className="mt-2">
            <div className="mb-1 flex justify-between text-sm">
              <span className="text-zinc-200">
                {activeRender.mode === 'final' ? 'Final export' : 'Preview'}{' '}
                {activeRender.status === 'queued' ? 'queued' : 'rendering'}…
              </span>
              <span className="tabular-nums text-studio-muted">
                {Math.round(activeRender.progress * 100)}%
              </span>
            </div>
            <ProgressBar value={activeRender.progress} indeterminate={activeRender.status === 'queued'} />
          </div>
        )}
        {latest?.video && (
          <div className="mt-5 grid gap-5 md:grid-cols-[auto_1fr]">
            <video
              key={latest.id}
              src={latest.video.url}
              poster={latest.thumbnailUrl ?? undefined}
              controls
              playsInline
              className="max-h-[520px] rounded-xl border border-studio-line bg-black"
              data-testid="latest-render"
            />
            <div className="space-y-2 text-sm">
              <div className="font-semibold text-white">
                Latest {latest.mode === 'final' ? 'export' : 'preview'}
              </div>
              <div className="text-studio-muted">
                {latest.width}×{latest.height} · {formatDuration(latest.durationSec)} ·{' '}
                {formatBytes(latest.video.sizeBytes)} · {formatDate(latest.createdAt)}
              </div>
              <div className="flex flex-wrap gap-2 pt-2">
                <a href={latest.video.downloadUrl}>
                  <Button variant="primary" size="sm">
                    ⬇ MP4
                  </Button>
                </a>
                {latest.srt && (
                  <a href={latest.srt.downloadUrl}>
                    <Button size="sm">⬇ SRT</Button>
                  </a>
                )}
                {bundle.voiceover && (
                  <a href={bundle.voiceover.downloadUrl}>
                    <Button size="sm">⬇ Voiceover</Button>
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <SectionTitle title="Individual downloads" subtitle="Scene clips and voiceover files." />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {bundle.scenes.map((s, i) => (
            <div
              key={s.id}
              className="flex items-center justify-between rounded-lg border border-studio-line px-3 py-2 text-sm"
            >
              <span className="truncate text-zinc-300">
                {i + 1}. {s.purpose || 'Scene'}
              </span>
              <span className="flex gap-2 text-xs">
                {s.clip ? (
                  <a className="text-violet-300" href={s.clip.downloadUrl}>
                    clip
                  </a>
                ) : (
                  <span className="text-studio-muted">no clip</span>
                )}
                {s.voiceover && (
                  <a className="text-violet-300" href={s.voiceover.downloadUrl}>
                    voice
                  </a>
                )}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle title="Render history" />
        {bundle.renders.length === 0 ? (
          <EmptyState title="No renders yet" />
        ) : (
          <ul className="divide-y divide-studio-line" data-testid="render-history">
            {bundle.renders.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
                {r.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.thumbnailUrl} alt="" className="h-12 w-12 rounded object-cover" />
                ) : (
                  <div className="h-12 w-12 rounded bg-white/5" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm text-white">
                    {r.mode === 'final' ? 'Final export' : 'Preview'}{' '}
                    <Badge status={r.status}>{r.status}</Badge>
                  </div>
                  <div className="text-xs text-studio-muted">
                    {formatDate(r.createdAt)} · {r.width}×{r.height}
                    {r.durationSec ? ` · ${formatDuration(r.durationSec)}` : ''}
                    {r.video ? ` · ${formatBytes(r.video.sizeBytes)}` : ''}
                  </div>
                  {r.status === 'running' && <ProgressBar className="mt-1 max-w-xs" value={r.progress} />}
                  {r.error && <div className="mt-1 text-xs text-red-300">{r.error}</div>}
                </div>
                <div className="flex gap-2">
                  {r.video && (
                    <a href={r.video.downloadUrl}>
                      <Button size="sm">⬇ MP4</Button>
                    </a>
                  )}
                  {r.srt && (
                    <a href={r.srt.downloadUrl}>
                      <Button size="sm" variant="ghost">
                        SRT
                      </Button>
                    </a>
                  )}
                  {(r.status === 'failed' || r.status === 'cancelled') && (
                    <Button
                      size="sm"
                      onClick={() =>
                        run(
                          `retry-${r.id}`,
                          async () =>
                            setBundle(await apiSend<ProjectBundle>(`/api/renders/${r.id}/retry`, 'POST')),
                          'Render re-queued',
                        )
                      }
                      loading={busy === `retry-${r.id}`}
                    >
                      Retry
                    </Button>
                  )}
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    confirmLabel="Delete?"
                    onConfirm={async () =>
                      setBundle(await apiSend<ProjectBundle>(`/api/renders/${r.id}`, 'DELETE'))
                    }
                  >
                    Delete
                  </ConfirmButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
