'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { CHARACTER_REF_ROLES, CHARACTER_UPLOAD_ROLES, LOOKS } from '@studio/core/schemas';
import { apiGet, apiSend, uploadFile } from '@/lib/api';
import type { CharacterAssetDTO, CharacterDetailDTO, CharacterDTO } from '@/lib/types';
import { NewCharacterFlow } from './NewCharacterFlow';
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  EmptyState,
  ErrorNote,
  InfoNote,
  Input,
  ProgressBar,
  SectionTitle,
  Select,
  Spinner,
  Textarea,
  useAction,
} from './ui';

const STATUS: Record<string, { status: string; label: string }> = {
  ready: { status: 'approved', label: 'ready' },
  review: { status: 'limited', label: 'review references' },
  preparing: { status: 'running', label: 'preparing' },
  none: { status: 'draft', label: 'not prepared' },
};

export function CharactersPage({
  startNew = false,
  initialId = null,
}: {
  startNew?: boolean;
  initialId?: string | null;
}) {
  const router = useRouter();
  const [list, setList] = useState<CharacterDTO[]>([]);
  const [selected, setSelected] = useState<string | 'new' | null>(startNew ? 'new' : initialId);
  const [detail, setDetail] = useState<CharacterDetailDTO | null>(null);

  const loadList = useCallback(
    async () => setList((await apiGet<{ characters: CharacterDTO[] }>('/api/characters')).characters),
    [],
  );
  const loadDetail = useCallback(
    async (id: string) =>
      setDetail((await apiGet<{ character: CharacterDetailDTO }>(`/api/characters/${id}`)).character),
    [],
  );
  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    if (selected && selected !== 'new') void loadDetail(selected);
    else setDetail(null);
  }, [selected, loadDetail]);

  const busy =
    detail?.status === 'preparing' || detail?.job?.status === 'queued' || detail?.job?.status === 'running';
  useEffect(() => {
    if (!busy || !detail) return;
    const t = setInterval(() => void loadDetail(detail.id).then(loadList), 2500);
    return () => clearInterval(t);
  }, [busy, detail, loadDetail, loadList]);

  const onChange = async (c: CharacterDetailDTO) => {
    setDetail(c);
    await loadList();
  };

  return (
    <div>
      <SectionTitle
        title="Characters"
        subtitle="Virtual people who stay the same in every video. Upload turnaround sheets once; every video uses the approved references."
        actions={
          <Button variant="primary" onClick={() => setSelected('new')} data-testid="new-character">
            + New character
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <div className="space-y-2">
          {list.length === 0 && selected !== 'new' && (
            <EmptyState title="No characters yet">Create one from your turnaround sheets.</EmptyState>
          )}
          {list.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelected(c.id)}
              data-testid="character-item"
              className={clsx(
                'card flex w-full items-center gap-3 p-3 text-left transition',
                selected === c.id ? 'border-studio-accent' : 'hover:border-studio-accent/50',
              )}
            >
              {c.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.avatar.url} alt="" className="h-12 w-12 rounded-full object-cover" />
              ) : (
                <span className="grid h-12 w-12 place-items-center rounded-full bg-white/5 text-xl">🧍</span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-white">{c.name}</span>
                <Badge status={STATUS[c.status]?.status}>{STATUS[c.status]?.label ?? c.status}</Badge>
              </span>
            </button>
          ))}
        </div>

        {selected === 'new' && (
          <NewCharacterFlow
            onDone={async (id) => {
              if (startNew) return router.push(`/characters?character=${id}`);
              setSelected(id);
              await loadList();
            }}
          />
        )}
        {detail && (
          <CharacterBoard
            key={detail.id}
            character={detail}
            onChange={onChange}
            busy={Boolean(busy)}
            onDeleted={async () => {
              setSelected(null);
              await loadList();
            }}
          />
        )}
      </div>
    </div>
  );
}

function CharacterBoard({
  character: c,
  onChange,
  busy,
  onDeleted,
}: {
  character: CharacterDetailDTO;
  onChange: (c: CharacterDetailDTO) => Promise<void>;
  busy: boolean;
  onDeleted: () => Promise<void>;
}) {
  const { busy: acting, run } = useAction();
  const [description, setDescription] = useState(c.description);
  const [scene, setScene] = useState('walking through a busy street market at golden hour');
  const [look, setLook] = useState<string>('ugc');
  const [progress, setProgress] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setDescription(c.description), [c.description]);
  const failed = c.job?.status === 'failed' && !busy ? c.job.error : null;
  const send = (key: string, url: string, body?: unknown, ok?: string) =>
    run(
      key,
      async () =>
        onChange((await apiSend<{ character: CharacterDetailDTO }>(url, 'POST', body ?? {})).character),
      ok,
    );

  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files).filter((x) => x.type.startsWith('image/'))) {
      setProgress(0);
      await run(`up-${f.name}`, async () =>
        onChange(
          (
            await uploadFile<{ character: CharacterDetailDTO }>(
              `/api/characters/${c.id}/assets`,
              f,
              { role: 'auto' },
              setProgress,
            )
          ).character,
        ),
      );
    }
    setProgress(null);
  };

  return (
    <Card className="space-y-6 p-5" data-testid="character-board">
      <div className="flex flex-wrap items-center gap-4">
        <h2 className="font-display text-2xl font-bold text-white">{c.name}</h2>
        <Badge status={STATUS[c.status]?.status}>{STATUS[c.status]?.label ?? c.status}</Badge>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            onClick={() => send('prepare', `/api/characters/${c.id}/prepare`, {}, 'Preparing the character…')}
            disabled={busy}
            loading={acting === 'prepare'}
            data-testid="prepare-character"
          >
            ✨ {c.references.length ? 'Rebuild from uploads' : 'Prepare character'}
          </Button>
          {c.references.length > 0 && c.status !== 'ready' && (
            <Button
              variant="primary"
              disabled={busy}
              loading={acting === 'approve'}
              data-testid="approve-character"
              onClick={() =>
                send('approve', `/api/characters/${c.id}/approve`, {}, `${c.name} is ready for videos`)
              }
            >
              Approve references
            </Button>
          )}
          <ConfirmButton
            variant="ghost"
            confirmLabel="Delete character and images?"
            onConfirm={async () => {
              await apiSend(`/api/characters/${c.id}`, 'DELETE');
              await onDeleted();
            }}
          >
            Delete
          </ConfirmButton>
        </div>
      </div>

      {busy && (
        <InfoNote>
          <span className="flex items-center gap-2">
            <Spinner /> Working on {c.name}… usually 30–90 seconds.
          </span>
        </InfoNote>
      )}
      {failed && <ErrorNote>Something went wrong: {failed}</ErrorNote>}

      {/* Approved references */}
      <section>
        <p className="label mb-2">References every video uses</p>
        {c.references.length === 0 ? (
          <EmptyState title="No references yet">
            Click “Prepare character” to make a clean face close-up and full-body reference from your uploads.
          </EmptyState>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2" data-testid="character-refs">
            {CHARACTER_REF_ROLES.map((role) => {
              const ref = c.references.find((r) => r.role === role.id);
              return (
                <div key={role.id} className="rounded-xl border border-studio-line p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-white">{role.label}</span>
                    {ref?.approved && <Badge status="approved">approved</Badge>}
                  </div>
                  <div className="mt-2 grid aspect-[4/5] place-items-center overflow-hidden rounded-lg bg-black/30">
                    {ref ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={ref.url}
                        alt={`${c.name} – ${role.label}`}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="text-sm text-studio-muted">Not generated</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    className="mt-2"
                    disabled={busy}
                    loading={acting === `ref-${role.id}`}
                    onClick={() =>
                      send(
                        `ref-${role.id}`,
                        `/api/characters/${c.id}/prepare`,
                        { role: role.id },
                        'Regenerating…',
                      )
                    }
                  >
                    ↻ Regenerate
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Identity */}
      <section>
        <p className="label mb-1">Identity description</p>
        <p className="mb-2 text-xs text-studio-muted">
          Repeated in every image and video prompt so the character stays the same. Edit freely.
        </p>
        <Textarea
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="character-description"
          onBlur={() =>
            description !== c.description &&
            run(
              'desc',
              async () =>
                onChange(
                  (
                    await apiSend<{ character: CharacterDetailDTO }>(`/api/characters/${c.id}`, 'PATCH', {
                      description,
                    })
                  ).character,
                ),
              'Saved',
            )
          }
        />
      </section>

      {/* Test shot */}
      {c.references.length > 0 && (
        <section className="rounded-xl border border-studio-line p-4">
          <p className="label mb-2">Test the likeness</p>
          <div className="flex flex-wrap gap-2">
            <Input
              value={scene}
              onChange={(e) => setScene(e.target.value)}
              className="min-w-[240px] flex-1"
              aria-label="Test scene"
            />
            <Select
              value={look}
              onChange={(e) => setLook(e.target.value)}
              aria-label="Look"
              className="!w-48"
            >
              {LOOKS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </Select>
            <Button
              disabled={busy || scene.trim().length < 3}
              loading={acting === 'test'}
              data-testid="test-shot"
              onClick={() =>
                send('test', `/api/characters/${c.id}/test-shot`, { scene, look }, 'Making a test shot…')
              }
            >
              📸 Make a test shot
            </Button>
          </div>
          {c.testShots.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6" data-testid="test-shots">
              {c.testShots.map((t) => (
                <a key={t.id} href={t.url} target="_blank" rel="noopener">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.url} alt="Test shot" className="aspect-[9/16] w-full rounded-lg object-cover" />
                </a>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Uploads */}
      <section>
        <p className="label mb-2">Your uploads</p>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
          }}
          className={clsx(
            'mb-3 flex items-center justify-between gap-3 rounded-xl border-2 border-dashed p-3 text-sm',
            dragOver ? 'border-studio-accent bg-studio-accent/10' : 'border-studio-line',
          )}
        >
          <span className="text-studio-muted">
            Drop more sheets or reference photos here, then “Rebuild from uploads”.
          </span>
          <Button
            size="sm"
            onClick={() => input.current?.click()}
            loading={progress !== null}
            data-testid="upload-character-image"
          >
            Upload
          </Button>
          <input
            ref={input}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            data-testid="character-upload-input"
            onChange={(e) => {
              if (e.target.files?.length) void upload(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        {progress !== null && <ProgressBar value={progress} />}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {c.uploads.map((u) => (
            <UploadCard key={u.id} characterId={c.id} upload={u} onChange={onChange} />
          ))}
        </div>
      </section>
    </Card>
  );
}

function UploadCard({
  characterId,
  upload: u,
  onChange,
}: {
  characterId: string;
  upload: CharacterAssetDTO;
  onChange: (c: CharacterDetailDTO) => Promise<void>;
}) {
  const url = `/api/characters/${characterId}/assets/${u.id}`;
  return (
    <div className="rounded-xl border border-studio-line p-2" data-testid="character-upload">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={u.url}
        alt={u.name ?? ''}
        className="aspect-square w-full rounded-lg bg-black/30 object-contain"
      />
      <Select
        aria-label="Image type"
        value={u.role}
        className="mt-2 !py-1 text-xs"
        onChange={async (e) =>
          onChange(
            (await apiSend<{ character: CharacterDetailDTO }>(url, 'PATCH', { role: e.target.value }))
              .character,
          )
        }
      >
        {u.role === 'auto' && (
          <option value="auto" disabled>
            Not sorted yet
          </option>
        )}
        {CHARACTER_UPLOAD_ROLES.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
      </Select>
      <ConfirmButton
        size="sm"
        variant="ghost"
        confirmLabel="Delete?"
        className="mt-1"
        onConfirm={async () =>
          onChange((await apiSend<{ character: CharacterDetailDTO }>(url, 'DELETE')).character)
        }
      >
        Delete
      </ConfirmButton>
    </div>
  );
}
