'use client';

import { useRef, useState } from 'react';
import { REFERENCE_CATEGORIES } from '@studio/core/schemas';
import { apiSend, uploadFile } from '@/lib/api';
import type { ProjectBundle, ReferenceDTO } from '@/lib/types';
import { formatBytes, formatDuration } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  Field,
  Input,
  ProgressBar,
  SectionTitle,
  Select,
  Textarea,
  useAction,
} from '../ui';
import { useProject } from './ProjectContext';

const NOTE_SUGGESTIONS = [
  'Use this editing pace',
  'Match this lighting style',
  'Use captions in a similar position',
  'Create a similar opening hook',
  'Use this colour palette',
  'Match this level of energy',
];

const ACCEPT = 'image/*,video/*,audio/*,.pdf,.txt,.md,.markdown';

export function ReferencesTab() {
  const { bundle, setBundle } = useProject();
  const p = bundle.project;
  const { busy, run } = useAction();
  const fileInput = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState('auto');
  const [usage, setUsage] = useState<'inspiration' | 'animate'>('inspiration');
  const [notes, setNotes] = useState('');
  const [uploads, setUploads] = useState<{ name: string; progress: number }[]>([]);
  const [url, setUrl] = useState('');
  const [linkNotes, setLinkNotes] = useState('');
  const [permission, setPermission] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const uploadAll = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      setUploads((u) => [...u, { name: file.name, progress: 0 }]);
      await run(
        `upload-${file.name}`,
        async () => {
          const animate = usage === 'animate' && file.type.startsWith('image/');
          const b = await uploadFile<ProjectBundle>(
            `/api/projects/${p.id}/references`,
            file,
            { category, notes, title: file.name, usage: animate ? 'animate' : 'inspiration' },
            (f) => setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, progress: f } : x))),
          );
          setBundle(b);
          if (animate) {
            // Newest reference is last; give it a ready-to-generate scene straight away.
            const ref = b.references.filter((r) => r.title === file.name && r.usage === 'animate').at(-1);
            if (ref)
              setBundle(await apiSend<ProjectBundle>(`/api/references/${ref.id}/animate-scene`, 'POST', {}));
          }
        },
        usage === 'animate' && file.type.startsWith('image/')
          ? `${file.name} added – a scene to animate it is on the Storyboard`
          : `${file.name} added – analysing…`,
      );
      setUploads((u) => u.filter((x) => x.name !== file.name));
    }
    setNotes('');
  };

  const addLink = () =>
    run(
      'link',
      async () => {
        setBundle(
          await apiSend<ProjectBundle>(`/api/projects/${p.id}/references`, 'POST', {
            url,
            notes: linkNotes,
            permissionConfirmed: permission,
          }),
        );
        setUrl('');
        setLinkNotes('');
      },
      'Link added – fetching public information…',
    );

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle
            title="Upload references"
            subtitle="Images, logos, posters, artwork, video clips, audio, music, text, Markdown or PDF documents."
          />
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length) void uploadAll(e.dataTransfer.files);
            }}
            onClick={() => fileInput.current?.click()}
            className={`cursor-pointer rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${dragOver ? 'border-studio-accent bg-studio-accent/10' : 'border-studio-line hover:border-studio-accent/60'}`}
          >
            <p className="text-sm text-zinc-200">Drop files here or click to browse</p>
            <p className="mt-1 text-xs text-studio-muted">
              Only upload content you own or have permission to use.
            </p>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              data-testid="reference-file-input"
              onChange={(e) => {
                if (e.target.files?.length) void uploadAll(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Use it as">
            {(
              [
                ['inspiration', 'Use as inspiration', 'Style, pace, colour – the AI makes something new.'],
                [
                  'animate',
                  'Animate this image',
                  'Images only: bring the poster / artwork itself to life, text and layout kept.',
                ],
              ] as const
            ).map(([id, label, hint]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={usage === id}
                data-testid={`usage-${id}`}
                onClick={() => setUsage(id)}
                className={`rounded-lg border p-2 text-left text-xs transition ${usage === id ? 'border-studio-accent bg-studio-accent/15 text-white' : 'border-studio-line text-studio-muted hover:text-white'}`}
              >
                <div className="text-sm font-medium">{label}</div>
                <div className="mt-0.5 leading-snug">{hint}</div>
              </button>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-[160px_1fr]">
            <Field label="Category">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="auto">Detect automatically</option>
                {REFERENCE_CATEGORIES.filter((c) => c !== 'link').map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="What do you like about it? (optional)">
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Match this lighting style"
              />
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {NOTE_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="rounded-full border border-studio-line px-2 py-0.5 text-[11px] text-studio-muted hover:text-white"
                onClick={() => setNotes(s)}
              >
                {s}
              </button>
            ))}
          </div>
          {uploads.map((u) => (
            <div key={u.name} className="mt-3">
              <div className="mb-1 flex justify-between text-xs text-studio-muted">
                <span className="truncate">{u.name}</span>
                <span>{Math.round(u.progress * 100)}%</span>
              </div>
              <ProgressBar value={u.progress} />
            </div>
          ))}
        </Card>

        <Card className="p-5">
          <SectionTitle
            title="Add a video link"
            subtitle="YouTube, Instagram, TikTok, Vimeo or a direct link to a public video file."
          />
          <div className="space-y-3">
            <Field label="Public URL">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/shorts/…"
                data-testid="reference-url"
              />
            </Field>
            <Field label="What do you like about it?">
              <Textarea
                rows={2}
                value={linkNotes}
                onChange={(e) => setLinkNotes(e.target.value)}
                placeholder="Use this editing pace, and a similar opening hook"
              />
            </Field>
            <label className="flex items-start gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={permission}
                onChange={(e) => setPermission(e.target.checked)}
                data-testid="reference-permission"
              />
              <span>
                I own this content or have permission to use it as a reference. The studio only reads publicly
                available information and never bypasses logins, DRM or platform protections.
              </span>
            </label>
            <p className="text-xs text-studio-muted">
              Platform pages (YouTube, TikTok, Instagram, Vimeo) only provide public metadata and a thumbnail.
              For full analysis of pace, framing and audio, upload the video file itself.
            </p>
            <Button
              variant="primary"
              onClick={addLink}
              disabled={!url || !permission}
              loading={busy === 'link'}
              data-testid="add-link"
            >
              Add link
            </Button>
          </div>
        </Card>
      </div>

      <div>
        <SectionTitle
          title={`Reference board (${bundle.references.length})`}
          subtitle="Analysis inspires an original video – it never copies the reference."
        />
        {bundle.references.length === 0 ? (
          <EmptyState title="Your board is empty">
            Add images, clips or links that capture the look and feel you want.
          </EmptyState>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {bundle.references.map((r) => (
              <ReferenceCard key={r.id} r={r} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ReferenceCard({ r }: { r: ReferenceDTO }) {
  const { setBundle } = useProject();
  const { busy, run } = useAction();
  const [notes, setNotes] = useState(r.notes);
  const [open, setOpen] = useState(false);
  const a = r.analysis;
  const isVideo = r.asset?.mime.startsWith('video/');
  const isAudio = r.asset?.mime.startsWith('audio/');
  const running = r.analysisStatus === 'queued' || r.analysisStatus === 'running';
  const isImage = Boolean(r.asset?.mime.startsWith('image/'));

  return (
    <Card className="flex flex-col overflow-hidden" data-testid="reference-card">
      <div className="relative aspect-video bg-black/40">
        {isVideo && r.asset ? (
          <video
            src={r.asset.url}
            poster={r.thumbnailUrl ?? undefined}
            controls
            preload="metadata"
            className="h-full w-full object-contain"
          />
        ) : r.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={r.thumbnailUrl} alt="" className="h-full w-full object-contain" />
        ) : isAudio && r.asset ? (
          <div className="grid h-full place-items-center p-4">
            <audio src={r.asset.url} controls className="w-full" />
          </div>
        ) : (
          <div className="grid h-full place-items-center text-3xl text-white/20">
            {r.kind === 'link' ? '🔗' : '📄'}
          </div>
        )}
        <div className="absolute left-2 top-2 flex gap-1.5">
          <Badge>{r.category}</Badge>
          {r.usage === 'animate' && <Badge status="approved">animate</Badge>}
          <Badge status={r.analysisStatus === 'completed' ? 'completed' : r.analysisStatus}>
            {r.analysisStatus === 'limited'
              ? 'metadata only'
              : r.analysisStatus === 'none'
                ? 'not analysed'
                : r.analysisStatus}
          </Badge>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <h3 className="truncate text-sm font-semibold text-white" title={r.title}>
            {r.title || r.sourceUrl || 'Untitled'}
          </h3>
          {r.sourceUrl && (
            <p className="truncate text-xs text-studio-muted" title={r.sourceUrl}>
              {r.platform} · {r.sourceUrl}
            </p>
          )}
          {r.asset && (
            <p className="text-xs text-studio-muted">
              {r.asset.mime} · {formatBytes(r.asset.sizeBytes)}
            </p>
          )}
        </div>
        <Field label="What I like about it">
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() =>
              notes !== r.notes &&
              run('notes', async () =>
                setBundle(await apiSend<ProjectBundle>(`/api/references/${r.id}`, 'PATCH', { notes })),
              )
            }
          />
        </Field>
        {r.error && <p className="text-xs text-red-300">{r.error}</p>}
        {a?.link?.note && <p className="text-xs text-amber-200">{a.link.note}</p>}
        {a && (
          <div className="text-xs text-zinc-300">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {a.technical?.durationSec !== undefined && (
                <span>⏱ {formatDuration(a.technical.durationSec)}</span>
              )}
              {a.technical?.width && (
                <span>
                  {a.technical.width}×{a.technical.height} ({a.technical.aspectRatio})
                </span>
              )}
              {a.editing && (
                <span>
                  ✂ {a.editing.shotCount} shots · avg {a.editing.averageShotLengthSec}s · {a.editing.pace}
                </span>
              )}
              {a.audio?.energy && <span>🔊 {a.audio.energy} energy</span>}
            </div>
            {a.palette && a.palette.length > 0 && (
              <div className="mt-2 flex gap-1">
                {a.palette.map((c) => (
                  <span
                    key={c}
                    title={c}
                    className="h-5 w-5 rounded border border-white/10"
                    style={{ background: c }}
                  />
                ))}
              </div>
            )}
            {(a.visual || a.transcript || a.text) && (
              <button
                className="mt-2 text-violet-300 hover:text-violet-200"
                onClick={() => setOpen((o) => !o)}
              >
                {open ? 'Hide analysis' : 'Show full analysis'}
              </button>
            )}
            {open && (
              <div className="mt-2 space-y-1.5 rounded-lg bg-black/30 p-3">
                {a.visual &&
                  Object.entries(a.visual).map(([k, v]) => (
                    <p key={k}>
                      <span className="text-studio-muted">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}:</span>{' '}
                      {v}
                    </p>
                  ))}
                {a.transcript && (
                  <p>
                    <span className="text-studio-muted">transcript:</span> {a.transcript.slice(0, 600)}
                  </p>
                )}
                {a.text && (
                  <p className="whitespace-pre-wrap">
                    <span className="text-studio-muted">document:</span> {a.text.slice(0, 800)}
                  </p>
                )}
                {a.notes?.map((n) => (
                  <p key={n} className="text-amber-200">
                    {n}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
        {r.frameUrls.length > 0 && (
          <div className="flex gap-1 overflow-x-auto">
            {r.frameUrls.map((f) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={f} src={f} alt="" className="h-14 w-auto rounded" />
            ))}
          </div>
        )}
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {isImage && (
            <>
              <Button
                size="sm"
                variant="primary"
                data-testid="animate-scene"
                loading={busy === 'animate'}
                onClick={() =>
                  run(
                    'animate',
                    async () =>
                      setBundle(
                        await apiSend<ProjectBundle>(`/api/references/${r.id}/animate-scene`, 'POST', {}),
                      ),
                    'Scene added – open the Storyboard to generate it',
                  )
                }
              >
                ✨ Animate → new scene
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  run('usage', async () =>
                    setBundle(
                      await apiSend<ProjectBundle>(`/api/references/${r.id}`, 'PATCH', {
                        usage: r.usage === 'animate' ? 'inspiration' : 'animate',
                      }),
                    ),
                  )
                }
              >
                {r.usage === 'animate' ? 'Use as inspiration' : 'Use for animation'}
              </Button>
            </>
          )}
          <Button
            size="sm"
            onClick={() =>
              run('analyze', async () =>
                setBundle(await apiSend<ProjectBundle>(`/api/references/${r.id}/analyze`, 'POST')),
              )
            }
            loading={busy === 'analyze'}
            disabled={running}
          >
            {running ? 'Analysing…' : 'Re-analyse'}
          </Button>
          {r.asset && (
            <a href={r.asset.downloadUrl}>
              <Button size="sm" variant="ghost">
                Download
              </Button>
            </a>
          )}
          <ConfirmButton
            size="sm"
            variant="ghost"
            confirmLabel="Delete?"
            onConfirm={async () =>
              setBundle(await apiSend<ProjectBundle>(`/api/references/${r.id}`, 'DELETE'))
            }
          >
            Delete
          </ConfirmButton>
        </div>
      </div>
    </Card>
  );
}
