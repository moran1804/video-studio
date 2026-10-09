'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import clsx from 'clsx';
import { TRANSITIONS, VIDEO_PROVIDER_LABELS, VIDEO_PROVIDERS } from '@studio/core/schemas';
import { apiSend, uploadFile } from '@/lib/api';
import type { ProjectBundle, SceneDTO } from '@/lib/types';
import { formatDuration } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  ErrorNote,
  Field,
  InfoNote,
  Input,
  ProgressBar,
  Select,
  Spinner,
  Textarea,
  useAction,
} from '../ui';
import { useProject } from './ProjectContext';

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-zinc-600',
  queued: 'bg-sky-500',
  generating: 'bg-violet-500 animate-pulse',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
  cancelled: 'bg-zinc-500',
};

type EditableScene = Pick<
  SceneDTO,
  | 'purpose'
  | 'durationSec'
  | 'visualDescription'
  | 'prompt'
  | 'camera'
  | 'lighting'
  | 'onScreenText'
  | 'voiceoverText'
  | 'transition'
  | 'audioDirection'
  | 'provider'
  | 'referenceAssetIds'
  | 'animateAssetId'
>;

const pick = (s: SceneDTO): EditableScene => ({
  purpose: s.purpose,
  durationSec: s.durationSec,
  visualDescription: s.visualDescription,
  prompt: s.prompt,
  camera: s.camera,
  lighting: s.lighting,
  onScreenText: s.onScreenText,
  voiceoverText: s.voiceoverText,
  transition: s.transition,
  audioDirection: s.audioDirection,
  provider: s.provider,
  referenceAssetIds: s.referenceAssetIds,
  animateAssetId: s.animateAssetId,
});

export function StoryboardTab() {
  const { bundle, setBundle, refresh } = useProject();
  const p = bundle.project;
  const { busy, run } = useAction();
  const [order, setOrder] = useState(bundle.scenes.map((s) => s.id));
  const [confirmReplace, setConfirmReplace] = useState(false);
  useEffect(() => setOrder(bundle.scenes.map((s) => s.id)), [bundle.scenes]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const scenes = order
    .map((id) => bundle.scenes.find((s) => s.id === id))
    .filter((s): s is SceneDTO => Boolean(s));
  const total = scenes.reduce((a, s) => a + s.durationSec, 0);
  const storyboardJob = bundle.jobs.find((j) => j.type === 'storyboard');
  const storyboardRunning =
    storyboardJob && (storyboardJob.status === 'queued' || storyboardJob.status === 'running');
  const done = scenes.filter((s) => s.status === 'completed').length;

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const next = arrayMove(order, order.indexOf(String(e.active.id)), order.indexOf(String(e.over.id)));
    setOrder(next);
    void run('reorder', async () =>
      setBundle(await apiSend<ProjectBundle>(`/api/projects/${p.id}/scenes/reorder`, 'POST', { ids: next })),
    );
  };

  const generateStoryboard = (replace: boolean) =>
    run('storyboard', async () => {
      try {
        await apiSend(`/api/projects/${p.id}/storyboard/generate`, 'POST', { replace });
        setConfirmReplace(false);
        await refresh();
      } catch (err) {
        if ((err as { code?: string }).code === 'confirm_replace') {
          setConfirmReplace(true);
          return;
        }
        throw err;
      }
    });

  if (p.briefStatus !== 'approved' && scenes.length === 0) {
    return (
      <EmptyState
        title="Approve the creative brief first"
        action={
          <Link href={`/projects/${p.id}`}>
            <Button variant="primary">Go to brief</Button>
          </Link>
        }
      >
        The storyboard is generated from your approved brief so every scene follows the same concept. Just
        want to animate a poster? Upload it on the Reference Board and click “Animate → new scene”.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-5">
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-zinc-300">
            <span className="font-semibold text-white">{scenes.length} scenes</span> · {formatDuration(total)}{' '}
            of {p.durationSec}s target ·{' '}
            <span className={done === scenes.length && scenes.length ? 'text-emerald-300' : ''}>
              {done}/{scenes.length} with footage
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => generateStoryboard(false)}
              loading={busy === 'storyboard'}
              disabled={Boolean(storyboardRunning) || p.briefStatus !== 'approved'}
              data-testid="generate-storyboard"
            >
              {scenes.length ? 'Regenerate storyboard' : 'Generate storyboard'}
            </Button>
            <Button
              onClick={() =>
                run('add', async () =>
                  setBundle(await apiSend<ProjectBundle>(`/api/projects/${p.id}/scenes`, 'POST', {})),
                )
              }
              loading={busy === 'add'}
              data-testid="add-scene"
            >
              + Add scene
            </Button>
            <Button
              variant="primary"
              disabled={!scenes.length}
              loading={busy === 'all'}
              data-testid="generate-all"
              onClick={() =>
                run(
                  'all',
                  async () => {
                    const r = await apiSend<{ queued: number }>(
                      `/api/projects/${p.id}/generate-all`,
                      'POST',
                      { onlyMissing: true },
                    );
                    await refresh();
                    return r;
                  },
                  'Queued generation for scenes without footage',
                )
              }
            >
              Generate missing scenes
            </Button>
          </div>
        </div>
        {confirmReplace && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100">
            Replacing the storyboard deletes the current scenes (generated clips stay in storage).
            <Button
              size="sm"
              variant="danger"
              onClick={() => generateStoryboard(true)}
              data-testid="confirm-replace"
            >
              Replace storyboard
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmReplace(false)}>
              Keep current
            </Button>
          </div>
        )}
        {storyboardRunning && (
          <div className="mt-3">
            <InfoNote>
              <span className="flex items-center gap-2">
                <Spinner /> Building the storyboard from your brief…
              </span>
            </InfoNote>
          </div>
        )}
        {storyboardJob?.status === 'failed' && (
          <div className="mt-3">
            <ErrorNote>Storyboard generation failed: {storyboardJob.error}</ErrorNote>
          </div>
        )}

        {scenes.length > 0 && (
          <div className="mt-4 flex h-12 w-full gap-1 overflow-hidden rounded-lg" aria-label="Timeline">
            {scenes.map((s, i) => (
              <a
                key={s.id}
                href={`#scene-${s.id}`}
                title={`Scene ${i + 1}: ${s.purpose} (${s.durationSec}s)`}
                style={{ flexGrow: s.durationSec }}
                className="group relative min-w-[28px] overflow-hidden rounded-md bg-white/5"
              >
                {s.thumbnailUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={s.thumbnailUrl}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover opacity-60 group-hover:opacity-90"
                  />
                )}
                <span
                  className={clsx(
                    'absolute bottom-0 left-0 h-1 w-full',
                    STATUS_COLOR[s.status] ?? 'bg-zinc-600',
                  )}
                />
                <span className="absolute left-1 top-1 text-[10px] font-semibold text-white drop-shadow">
                  {i + 1}
                </span>
              </a>
            ))}
          </div>
        )}
      </Card>

      {scenes.length === 0 ? (
        <EmptyState title="No scenes yet">
          Generate a storyboard from your approved brief or add scenes manually.
        </EmptyState>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <div className="space-y-4" data-testid="scene-list">
              {scenes.map((s, i) => (
                <SceneCard key={s.id} scene={s} index={i} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function SceneCard({ scene, index }: { scene: SceneDTO; index: number }) {
  const { bundle, setBundle, refresh } = useProject();
  const { busy, run } = useAction();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: scene.id,
  });
  const [draft, setDraft] = useState<EditableScene>(pick(scene));
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState(index === 0 && scene.status === 'draft');
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  useEffect(() => {
    if (!dirty) setDraft(pick(scene));
  }, [scene, dirty]);

  const set = <K extends keyof EditableScene>(k: K, v: EditableScene[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setDirty(true);
  };

  const save = async () => {
    setBundle(
      await apiSend<ProjectBundle>(`/api/scenes/${scene.id}`, 'PATCH', {
        ...draft,
        durationSec: Number(draft.durationSec),
      }),
    );
    setDirty(false);
  };

  const active = scene.status === 'queued' || scene.status === 'generating';
  const promptJob = bundle.jobs.find(
    (j) => j.type === 'prompt' && j.sceneId === scene.id && (j.status === 'queued' || j.status === 'running'),
  );
  const words = draft.voiceoverText.split(/\s+/).filter(Boolean).length;
  const voTooLong = words > 0 && words / 2.7 > Number(draft.durationSec) + 0.5;
  const refOptions = useMemo(
    () =>
      bundle.references
        .map((r) => ({
          id: r.asset?.id ?? r.thumbnailUrl?.split('/').pop() ?? null,
          title: r.title || r.category,
          thumb: r.thumbnailUrl ?? (r.asset?.mime.startsWith('image/') ? r.asset.url : null),
        }))
        .filter((r): r is { id: string; title: string; thumb: string | null } => Boolean(r.id)),
    [bundle.references],
  );
  const imageOptions = useMemo(
    () =>
      bundle.references
        .filter((r) => r.asset?.mime.startsWith('image/'))
        .map((r) => ({
          id: r.asset!.id,
          title: r.title || r.asset!.name || 'image',
          animate: r.usage === 'animate',
        })),
    [bundle.references],
  );

  return (
    <div
      ref={setNodeRef}
      id={`scene-${scene.id}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={clsx(isDragging && 'z-10 opacity-80')}
    >
      <Card className="overflow-hidden" data-testid="scene-card">
        <div className="flex flex-wrap items-center gap-3 border-b border-studio-line px-4 py-3">
          <button
            {...attributes}
            {...listeners}
            className="cursor-grab rounded px-1 text-lg text-studio-muted hover:text-white active:cursor-grabbing"
            aria-label={`Drag scene ${index + 1}`}
            data-testid="drag-handle"
          >
            ⋮⋮
          </button>
          <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs font-semibold text-white">
            Scene {index + 1}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-zinc-200" data-testid="scene-purpose">
            {scene.purpose || 'Untitled scene'}
          </span>
          {scene.animateUrl && (
            <span
              className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-200"
              title="Animates your uploaded image – text and layout are kept"
              data-testid="scene-animates"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={scene.animateUrl} alt="" className="h-4 w-4 rounded-sm object-cover" />
              animates image
            </span>
          )}
          <span className="text-xs text-studio-muted">{scene.durationSec}s</span>
          <Badge status={scene.status}>
            {scene.clipSource === 'uploaded' && scene.status === 'completed' ? 'uploaded' : scene.status}
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => setExpanded((e) => !e)} data-testid="edit-scene">
            {expanded ? 'Collapse' : 'Edit'}
          </Button>
        </div>

        <div className="grid gap-4 p-4 md:grid-cols-[220px_1fr]">
          <div>
            <div
              className={clsx(
                'relative mx-auto overflow-hidden rounded-lg bg-black/50',
                bundle.project.aspectRatio === '16:9'
                  ? 'aspect-video'
                  : bundle.project.aspectRatio === '1:1'
                    ? 'aspect-square'
                    : bundle.project.aspectRatio === '4:5'
                      ? 'aspect-[4/5]'
                      : 'aspect-[9/16] max-h-[360px]',
              )}
            >
              {scene.clip ? (
                <video
                  key={scene.clip.id}
                  src={scene.clip.url}
                  poster={scene.thumbnailUrl ?? undefined}
                  controls
                  preload="metadata"
                  playsInline
                  className="h-full w-full object-cover"
                  data-testid="scene-preview"
                />
              ) : (
                <div className="grid h-full place-items-center p-3 text-center text-xs text-studio-muted">
                  {active ? 'Generating…' : 'No footage yet'}
                </div>
              )}
              {active && (
                <div className="absolute inset-x-2 bottom-2">
                  <ProgressBar value={scene.job?.progress ?? 0.1} indeterminate={!scene.job?.progress} />
                </div>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {active ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() =>
                    run(
                      'cancel',
                      async () => {
                        await apiSend(`/api/scenes/${scene.id}/cancel`, 'POST');
                        await refresh();
                      },
                      'Cancelling…',
                    )
                  }
                  loading={busy === 'cancel'}
                >
                  Cancel
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  data-testid="generate-scene"
                  loading={busy === 'gen'}
                  onClick={() =>
                    run(
                      'gen',
                      async () => {
                        if (dirty) await save();
                        await apiSend(`/api/scenes/${scene.id}/generate`, 'POST', {});
                        await refresh();
                      },
                      'Scene queued for generation',
                    )
                  }
                >
                  {scene.clip ? 'Regenerate' : 'Generate'}
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => fileInput.current?.click()}
                disabled={active}
                loading={uploadProgress !== null}
              >
                Upload clip
              </Button>
              {scene.clip && (
                <a href={scene.clip.downloadUrl}>
                  <Button size="sm" variant="ghost">
                    ⬇
                  </Button>
                </a>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  setUploadProgress(0);
                  void run(
                    'upload',
                    async () =>
                      setBundle(
                        await uploadFile<ProjectBundle>(
                          `/api/scenes/${scene.id}/clip`,
                          f,
                          {},
                          setUploadProgress,
                        ),
                      ),
                    'Clip replaced',
                  ).finally(() => setUploadProgress(null));
                }}
              />
            </div>
            {uploadProgress !== null && <ProgressBar className="mt-2" value={uploadProgress} />}
            {scene.status === 'failed' && scene.error && (
              <p className="mt-2 text-xs text-red-300">{scene.error}</p>
            )}
            {scene.job?.status === 'queued' && scene.job.error && (
              <p className="mt-2 text-xs text-amber-300">{scene.job.error}</p>
            )}
          </div>

          <div className="min-w-0">
            {!expanded ? (
              <div className="space-y-2 text-sm">
                <p className="text-zinc-300">
                  {scene.visualDescription || (
                    <span className="text-studio-muted">No visual description</span>
                  )}
                </p>
                {scene.voiceoverText && <p className="text-zinc-400">🎙 “{scene.voiceoverText}”</p>}
                {scene.onScreenText && <p className="text-zinc-400">🅣 {scene.onScreenText}</p>}
                <p className="text-xs text-studio-muted">
                  {VIDEO_PROVIDER_LABELS[scene.provider as keyof typeof VIDEO_PROVIDER_LABELS] ??
                    scene.provider}{' '}
                  · transition: {scene.transition}
                </p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Purpose">
                  <Input
                    value={draft.purpose}
                    onChange={(e) => set('purpose', e.target.value)}
                    data-testid="field-purpose"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Duration (s)">
                    <Input
                      type="number"
                      min={1}
                      max={30}
                      step={0.5}
                      value={draft.durationSec}
                      onChange={(e) => set('durationSec', Number(e.target.value))}
                      data-testid="field-duration"
                    />
                  </Field>
                  <Field label="Transition out">
                    <Select value={draft.transition} onChange={(e) => set('transition', e.target.value)}>
                      {TRANSITIONS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Visual description" className="sm:col-span-2">
                  <Textarea
                    rows={2}
                    value={draft.visualDescription}
                    onChange={(e) => set('visualDescription', e.target.value)}
                  />
                </Field>
                <Field
                  label="Video-generation prompt"
                  className="sm:col-span-2"
                  hint={
                    <span className="flex flex-wrap items-center gap-2">
                      {draft.prompt.length} characters
                      <button
                        type="button"
                        className="text-violet-300 hover:text-violet-200 disabled:opacity-50"
                        disabled={Boolean(promptJob)}
                        onClick={() =>
                          run(
                            'prompt',
                            async () => {
                              if (dirty) await save();
                              await apiSend(`/api/scenes/${scene.id}/prompt`, 'POST');
                              await refresh();
                            },
                            'Rewriting prompt…',
                          )
                        }
                        data-testid="regenerate-prompt"
                      >
                        {promptJob ? 'Rewriting…' : '✨ Rewrite with AI'}
                      </button>
                    </span>
                  }
                >
                  <Textarea
                    rows={4}
                    value={draft.prompt}
                    onChange={(e) => set('prompt', e.target.value)}
                    data-testid="field-prompt"
                  />
                </Field>
                <Field label="Camera direction">
                  <Input value={draft.camera} onChange={(e) => set('camera', e.target.value)} />
                </Field>
                <Field label="Lighting">
                  <Input value={draft.lighting} onChange={(e) => set('lighting', e.target.value)} />
                </Field>
                <Field label="On-screen text">
                  <Input
                    value={draft.onScreenText}
                    onChange={(e) => set('onScreenText', e.target.value)}
                    maxLength={500}
                  />
                </Field>
                <Field label="Generation provider">
                  <Select value={draft.provider} onChange={(e) => set('provider', e.target.value)}>
                    {VIDEO_PROVIDERS.map((pr) => (
                      <option key={pr} value={pr}>
                        {VIDEO_PROVIDER_LABELS[pr]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Voiceover text"
                  className="sm:col-span-2"
                  hint={
                    voTooLong ? (
                      <span className="text-amber-300">
                        ~{Math.round(words / 2.7)}s of speech – longer than the scene. Shorten the text or
                        extend the scene.
                      </span>
                    ) : (
                      `${words} words`
                    )
                  }
                >
                  <Textarea
                    rows={2}
                    value={draft.voiceoverText}
                    onChange={(e) => set('voiceoverText', e.target.value)}
                  />
                </Field>
                <Field label="Audio direction" className="sm:col-span-2">
                  <Input
                    value={draft.audioDirection}
                    onChange={(e) => set('audioDirection', e.target.value)}
                  />
                </Field>
                <Field
                  label="Animate an image (start frame)"
                  className="sm:col-span-2"
                  hint="The image itself is brought to life – ideal for posters and flyers. Upload images on the Reference Board."
                >
                  <Select
                    value={draft.animateAssetId ?? ''}
                    data-testid="field-animate"
                    onChange={(e) => set('animateAssetId', e.target.value || null)}
                  >
                    <option value="">None – generate from the prompt</option>
                    {imageOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.title}
                        {o.animate ? ' (marked for animation)' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
                {refOptions.length > 0 && (
                  <div className="sm:col-span-2">
                    <span className="label">Reference assets (first image guides generation)</span>
                    <div className="flex flex-wrap gap-2">
                      {refOptions.map((r) => {
                        const on = draft.referenceAssetIds.includes(r.id);
                        return (
                          <button
                            type="button"
                            key={r.id}
                            onClick={() =>
                              set(
                                'referenceAssetIds',
                                on
                                  ? draft.referenceAssetIds.filter((x) => x !== r.id)
                                  : [...draft.referenceAssetIds, r.id],
                              )
                            }
                            className={clsx(
                              'flex items-center gap-2 rounded-lg border px-2 py-1 text-xs',
                              on
                                ? 'border-studio-accent bg-studio-accent/15 text-white'
                                : 'border-studio-line text-studio-muted',
                            )}
                          >
                            {r.thumb && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={r.thumb} alt="" className="h-6 w-6 rounded object-cover" />
                            )}
                            <span className="max-w-[140px] truncate">{r.title}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() =>
                        run(
                          'dup',
                          async () =>
                            setBundle(
                              await apiSend<ProjectBundle>(`/api/scenes/${scene.id}/duplicate`, 'POST'),
                            ),
                          'Scene duplicated',
                        )
                      }
                      data-testid="duplicate-scene"
                    >
                      Duplicate
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        run('after', async () =>
                          setBundle(
                            await apiSend<ProjectBundle>(
                              `/api/projects/${bundle.project.id}/scenes`,
                              'POST',
                              { afterPosition: scene.position },
                            ),
                          ),
                        )
                      }
                    >
                      + Scene after
                    </Button>
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      confirmLabel="Delete scene?"
                      onConfirm={async () =>
                        setBundle(await apiSend<ProjectBundle>(`/api/scenes/${scene.id}`, 'DELETE'))
                      }
                      data-testid="delete-scene"
                    >
                      Delete
                    </ConfirmButton>
                  </div>
                  <div className="flex gap-2">
                    {dirty && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setDraft(pick(scene));
                          setDirty(false);
                        }}
                      >
                        Discard
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!dirty}
                      loading={busy === 'save'}
                      onClick={() => run('save', save, 'Scene saved')}
                      data-testid="save-scene"
                    >
                      Save scene
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
