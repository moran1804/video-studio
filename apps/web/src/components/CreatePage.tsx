'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { LOOKS, VIDEO_PROVIDER_LABELS, VIDEO_PROVIDERS } from '@studio/core/schemas';
import { apiGet, apiSend, uploadFile } from '@/lib/api';
import type { BrandDTO, CharacterDTO } from '@/lib/types';
import type { QuickItem } from '@/server/quick';
import { Button, ConfirmButton, ProgressBar, Select, Spinner, useToast } from './ui';

const FORMATS = [
  {
    id: 'vertical',
    label: 'Reels / TikTok / Shorts · 9:16',
    platform: 'instagram_reels',
    aspectRatio: '9:16',
  },
  {
    id: 'feed',
    label: 'Instagram / Facebook feed · 4:5',
    platform: 'facebook_instagram_promo',
    aspectRatio: '4:5',
  },
  { id: 'square', label: 'Square · 1:1', platform: 'facebook_instagram_promo', aspectRatio: '1:1' },
  { id: 'landscape', label: 'YouTube / landscape · 16:9', platform: 'landscape_promo', aspectRatio: '16:9' },
] as const;
const LENGTHS = [5, 8, 10, 15, 20, 30];
const NEW_BRAND = '__new_brand__';

const STAGE_LABEL: Record<string, string> = {
  plan: 'Planning the video…',
  generate: 'Generating footage…',
  voiceover: 'Recording the voiceover…',
  render: 'Editing and rendering…',
  done: 'Finishing…',
};

interface Settings {
  format: (typeof FORMATS)[number]['id'];
  length: number;
  brandId: string;
  provider: string;
  voiceover: boolean;
  voiceId: string;
  captions: boolean;
  music: boolean;
  logo: boolean;
  characterId: string;
  look: string;
  onScreenText: boolean;
}

const DEFAULTS: Settings = {
  format: 'vertical',
  length: 8,
  brandId: '',
  provider: '',
  voiceover: false,
  voiceId: '',
  captions: true,
  music: false,
  logo: true,
  characterId: '',
  look: 'ugc',
  onScreenText: false,
};
const NEW_CHARACTER = '__new_character__';
const STORE_KEY = 'studio.create.settings';

interface Attachment {
  file: File;
  url: string;
  usage: 'animate' | 'inspiration' | 'motion';
}

const isActive = (i: QuickItem) => i.job?.status === 'queued' || i.job?.status === 'running';

export function CreatePage({
  brands: initialBrands,
  characters: initialCharacters,
  initial,
  defaultProvider,
}: {
  brands: BrandDTO[];
  characters: CharacterDTO[];
  initial: QuickItem[];
  defaultProvider: string;
}) {
  const toast = useToast();
  const [brands, setBrands] = useState(initialBrands);
  const [characters, setCharacters] = useState(initialCharacters);
  const [items, setItems] = useState<QuickItem[]>(initial);
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [voices, setVoices] = useState<{ id: string; name: string }[] | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const musicInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // Remember the options between visits (per browser).
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Partial<Settings> | null;
      if (saved)
        setSettings((s) => ({
          ...s,
          ...saved,
          brandId: brands.some((b) => b.id === saved.brandId) ? saved.brandId! : '',
        }));
    } catch {
      /* storage unavailable */
    }
  }, [brands]);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setSettings((s) => {
      const next = { ...s, [k]: v };
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });

  useEffect(() => {
    if (!settings.voiceover || voices) return;
    void apiGet<{ voices: { id: string; name: string }[] }>('/api/voices').then((r) => setVoices(r.voices));
  }, [settings.voiceover, voices]);

  // Oldest first, like a chat; scroll to the newest.
  const ordered = useMemo(() => [...items].reverse(), [items]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [items.length]);

  // Poll the videos that are still being made.
  const activeIds = items
    .filter(isActive)
    .map((i) => i.id)
    .join(',');
  const refresh = useCallback(async (ids: string) => {
    const { items: fresh } = await apiGet<{ items: QuickItem[] }>(`/api/quick?ids=${ids}`);
    setItems((cur) => cur.map((i) => fresh.find((f) => f.id === i.id) ?? i));
  }, []);
  useEffect(() => {
    if (!activeIds) return;
    const t = setInterval(() => void refresh(activeIds).catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, [activeIds, refresh]);

  const brand = brands.find((b) => b.id === settings.brandId) ?? null;

  // Brands / characters built in another tab show up when you come back here.
  useEffect(() => {
    const reload = () => {
      void apiGet<{ brands: BrandDTO[] }>('/api/brands')
        .then((r) => setBrands(r.brands))
        .catch(() => undefined);
      void apiGet<{ characters: CharacterDTO[] }>('/api/characters')
        .then((r) => setCharacters(r.characters))
        .catch(() => undefined);
    };
    // Also on mount: client-side navigation can show a cached copy of this page.
    reload();
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, []);

  const addFiles = (list: FileList) => {
    const all = Array.from(list);
    const images = all.filter((f) => f.type.startsWith('image/'));
    // Videos are movement sources: the chosen character copies the motion (Kling).
    const videos = settings.characterId ? all.filter((f) => f.type.startsWith('video/')).slice(0, 1) : [];
    if (images.length + videos.length < all.length) {
      toast(
        settings.characterId
          ? 'Attach images, or one video for the character to copy the movement from.'
          : 'Attach images – pick a character to copy movement from a video.',
        'error',
      );
    }
    setAttachments((cur) => [
      ...cur.filter((a) => !(videos.length && a.usage === 'motion')),
      ...images.map((file) => ({
        file,
        url: URL.createObjectURL(file),
        usage: (settings.characterId ? 'inspiration' : 'animate') as Attachment['usage'],
      })),
      ...videos.map((file) => ({ file, url: URL.createObjectURL(file), usage: 'motion' as const })),
    ]);
  };

  const send = async () => {
    const text = prompt.trim();
    if (text.length < 3) return;
    const format = FORMATS.find((f) => f.id === settings.format)!;
    try {
      setSending('Creating…');
      const { id } = await apiSend<{ id: string }>('/api/projects', 'POST', {
        name: text.slice(0, 60),
        platform: format.platform,
        aspectRatio: format.aspectRatio,
        durationSec: settings.length,
        brandId: settings.brandId || null,
        defaultProvider: settings.provider || null,
        details: { source: 'quick', request: text },
      });
      for (const [i, a] of attachments.entries()) {
        setSending(
          `Uploading ${a.usage === 'motion' ? 'movement video' : 'image'} ${i + 1} of ${attachments.length}…`,
        );
        await uploadFile(`/api/projects/${id}/references`, a.file, { title: a.file.name, usage: a.usage });
      }
      if (settings.music && musicFile) {
        setSending('Uploading music…');
        await uploadFile(`/api/projects/${id}/assets?kind=music`, musicFile);
      }
      setSending('Starting…');
      const { item } = await apiSend<{ item: QuickItem }>(`/api/projects/${id}/quick`, 'POST', {
        prompt: text,
        provider: settings.provider || null,
        voiceover: settings.voiceover,
        voiceId: settings.voiceId,
        captions: settings.captions,
        music: settings.music && Boolean(musicFile),
        logo: settings.logo,
        characterId: settings.characterId || null,
        look: settings.look,
        onScreenText: settings.onScreenText,
      });
      setItems((cur) => [item, ...cur]);
      setPrompt('');
      attachments.forEach((a) => URL.revokeObjectURL(a.url));
      setAttachments([]);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start the video', 'error');
    } finally {
      setSending(null);
    }
  };

  const retry = async (item: QuickItem) => {
    try {
      const { item: next } = await apiSend<{ item: QuickItem }>(`/api/projects/${item.id}/quick`, 'POST', {
        ...(item.options ?? {}),
        prompt: item.prompt,
      });
      setItems((cur) => cur.map((i) => (i.id === item.id ? next : i)));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not restart', 'error');
    }
  };

  const musicNeeded = settings.music && !musicFile;

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl flex-col">
      <div className="flex-1 space-y-8 pb-6" data-testid="create-feed">
        {ordered.length === 0 && (
          <div className="pt-16 text-center">
            <h1 className="font-display text-3xl font-bold text-white">What video should we make?</h1>
            <p className="mt-2 text-sm text-studio-muted">
              Describe it in a sentence or two. Attach a poster or image to animate it. Pick options below,
              then send.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {[
                'A cinematic teaser for our rooftop summer party – neon lights, crowd, sunset',
                'Animate this poster with subtle motion and glowing lights',
                'A 15-second product ad for our new cold brew coffee',
              ].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setPrompt(s)}
                  className="rounded-full border border-studio-line px-3 py-1.5 text-xs text-studio-muted transition hover:border-studio-accent/60 hover:text-white"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {ordered.map((item) => (
          <Exchange
            key={item.id}
            item={item}
            onRetry={() => retry(item)}
            onCancel={async () => {
              if (item.job) await apiSend(`/api/jobs/${item.job.id}/cancel`, 'POST');
              await refresh(item.id);
            }}
            onDelete={async () => {
              await apiSend(`/api/projects/${item.id}`, 'DELETE');
              setItems((cur) => cur.filter((i) => i.id !== item.id));
            }}
          />
        ))}
        <div ref={bottom} />
      </div>

      {/* Composer */}
      <div className="sticky bottom-0 -mx-4 bg-studio-bg/95 px-4 pb-4 pt-2 backdrop-blur sm:mx-0 sm:px-0">
        <div className="rounded-2xl border border-studio-line bg-studio-panel p-3 shadow-lg focus-within:border-studio-accent/70">
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a, i) => (
                <div
                  key={a.url}
                  className="flex items-center gap-2 rounded-lg border border-studio-line bg-black/20 p-1.5 pr-2"
                  data-testid="attachment"
                >
                  {a.usage === 'motion' ? (
                    <video src={a.url} muted playsInline className="h-10 w-10 rounded object-cover" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.url} alt="" className="h-10 w-10 rounded object-cover" />
                  )}
                  <select
                    disabled={a.usage === 'motion'}
                    aria-label={`How to use ${a.file.name}`}
                    value={a.usage}
                    onChange={(e) =>
                      setAttachments((cur) =>
                        cur.map((x, j) =>
                          j === i ? { ...x, usage: e.target.value as Attachment['usage'] } : x,
                        ),
                      )
                    }
                    className="rounded bg-transparent text-xs text-zinc-200 outline-none"
                  >
                    {a.usage === 'motion' ? (
                      <option value="motion">Copy this movement</option>
                    ) : (
                      <>
                        {!settings.characterId && <option value="animate">Animate this image</option>}
                        <option value="inspiration">Use as inspiration</option>
                      </>
                    )}
                  </select>
                  <button
                    type="button"
                    aria-label={`Remove ${a.file.name}`}
                    className="text-studio-muted hover:text-red-300"
                    onClick={() => {
                      URL.revokeObjectURL(a.url);
                      setAttachments((cur) => cur.filter((_, j) => j !== i));
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!sending && !musicNeeded) void send();
              }
            }}
            rows={2}
            maxLength={4000}
            placeholder="Describe the video you want…"
            aria-label="Describe the video you want"
            data-testid="create-prompt"
            className="w-full resize-none bg-transparent text-sm text-white placeholder:text-studio-muted focus:outline-none"
          />
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              className="rounded-lg px-2 py-1 text-sm text-studio-muted hover:bg-white/5 hover:text-white"
              data-testid="attach"
            >
              📎 {settings.characterId ? 'Attach image or movement video' : 'Attach image'}
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={
                settings.characterId
                  ? 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm'
                  : 'image/png,image/jpeg,image/webp,image/gif'
              }
              className="hidden"
              data-testid="attach-input"
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <div className="flex items-center gap-2">
              {sending && <span className="text-xs text-studio-muted">{sending}</span>}
              <Button
                variant="primary"
                onClick={() => void send()}
                loading={Boolean(sending)}
                disabled={prompt.trim().length < 3 || musicNeeded}
                data-testid="create-send"
              >
                Create video ↑
              </Button>
            </div>
          </div>
        </div>

        {/* Options */}
        <div className="mt-3 grid gap-2 sm:grid-cols-2" data-testid="character-options">
          <Select
            aria-label="Character"
            value={settings.characterId}
            data-testid="create-character"
            onChange={(e) => {
              if (e.target.value === NEW_CHARACTER) {
                window.open('/characters/new', '_blank', 'noopener');
                return;
              }
              set('characterId', e.target.value);
              // Images become style references for character videos; movement videos need a character.
              setAttachments((cur) =>
                e.target.value
                  ? cur.map((a) => (a.usage === 'animate' ? { ...a, usage: 'inspiration' } : a))
                  : cur.filter((a) => a.usage !== 'motion'),
              );
            }}
          >
            <option value="">No character</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id} disabled={c.status === 'none' || c.status === 'preparing'}>
                {c.name}
                {c.status === 'ready'
                  ? ' ✓'
                  : c.status === 'review'
                    ? ' (references not approved)'
                    : ' (not ready)'}
              </option>
            ))}
            <option value={NEW_CHARACTER}>+ New character from turnaround sheets…</option>
          </Select>
          {settings.characterId ? (
            <Select
              aria-label="Look"
              value={settings.look}
              onChange={(e) => set('look', e.target.value)}
              data-testid="create-look"
            >
              {LOOKS.map((l) => (
                <option key={l.id} value={l.id}>
                  Look: {l.label}
                </option>
              ))}
            </Select>
          ) : (
            <p className="self-center text-xs text-studio-muted">
              Pick a character for realistic videos of the same person every time.
            </p>
          )}
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-4" data-testid="create-options">
          <Select
            aria-label="Format"
            value={settings.format}
            onChange={(e) => set('format', e.target.value as Settings['format'])}
          >
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Length"
            value={settings.length}
            onChange={(e) => set('length', Number(e.target.value))}
          >
            {LENGTHS.map((l) => (
              <option key={l} value={l}>
                {l} seconds
              </option>
            ))}
          </Select>
          <Select
            aria-label="Brand / design system"
            value={settings.brandId}
            onChange={(e) => {
              if (e.target.value === NEW_BRAND) {
                window.open('/brands/new', '_blank', 'noopener');
                return;
              }
              set('brandId', e.target.value);
            }}
            data-testid="create-brand"
          >
            <option value="">No brand</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.designStatus === 'approved' ? ' ✓' : ''}
              </option>
            ))}
            <option value={NEW_BRAND}>+ New brand from logos/posters…</option>
          </Select>
          <Select
            aria-label="Video model"
            value={settings.provider}
            onChange={(e) => set('provider', e.target.value)}
          >
            <option value="">
              {settings.characterId
                ? 'Veo 3.1 (best for characters)'
                : `${VIDEO_PROVIDER_LABELS[defaultProvider as keyof typeof VIDEO_PROVIDER_LABELS] ?? defaultProvider} (default)`}
            </option>
            {VIDEO_PROVIDERS.filter((p) => p !== defaultProvider && p !== 'mock').map((p) => (
              <option key={p} value={p}>
                {VIDEO_PROVIDER_LABELS[p]}
              </option>
            ))}
          </Select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-zinc-200">
          <Check
            label="Voiceover"
            checked={settings.voiceover}
            onChange={(v) => set('voiceover', v)}
            testId="opt-voiceover"
          />
          {settings.voiceover && (
            <Select
              aria-label="Voice"
              value={settings.voiceId}
              onChange={(e) => set('voiceId', e.target.value)}
              className="!w-48 !py-1 text-xs"
            >
              <option value="">{voices ? 'Default voice' : 'Loading voices…'}</option>
              {(voices ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          )}
          <Check
            label={settings.voiceover ? 'Captions' : 'Captions (needs voiceover)'}
            checked={settings.captions && settings.voiceover}
            disabled={!settings.voiceover}
            onChange={(v) => set('captions', v)}
            testId="opt-captions"
          />
          <Check
            label="On-screen text"
            checked={settings.onScreenText}
            onChange={(v) => set('onScreenText', v)}
            testId="opt-onscreen"
          />
          <Check
            label="Background music"
            checked={settings.music}
            onChange={(v) => set('music', v)}
            testId="opt-music"
          />
          {settings.music && (
            <>
              <button
                type="button"
                onClick={() => musicInput.current?.click()}
                className={clsx(
                  'rounded-lg border px-2 py-1 text-xs',
                  musicFile ? 'border-studio-line text-zinc-200' : 'border-amber-400/60 text-amber-200',
                )}
              >
                {musicFile ? `♪ ${musicFile.name}` : 'Choose a music file (you must own the rights)'}
              </button>
              <input
                ref={musicInput}
                type="file"
                accept="audio/*"
                className="hidden"
                data-testid="music-input"
                onChange={(e) => {
                  setMusicFile(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
            </>
          )}
          {brand && (
            <Check
              label="Logo & outro card"
              checked={settings.logo}
              onChange={(v) => set('logo', v)}
              testId="opt-logo"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <label
      className={clsx('flex cursor-pointer items-center gap-2', disabled && 'cursor-not-allowed opacity-50')}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        className="h-4 w-4 accent-violet-600"
      />
      {label}
    </label>
  );
}

function Exchange({
  item,
  onRetry,
  onCancel,
  onDelete,
}: {
  item: QuickItem;
  onRetry: () => Promise<void>;
  onCancel: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const active = isActive(item);
  const failed = item.job?.status === 'failed' || item.job?.status === 'cancelled';
  const o = item.options;
  const chips = [
    item.aspectRatio,
    `${item.durationSec}s`,
    item.brand?.name,
    o?.voiceover && 'voiceover',
    o?.voiceover && o.captions && 'captions',
    o?.music && 'music',
  ].filter(Boolean) as string[];
  const portrait = item.aspectRatio === '9:16' || item.aspectRatio === '4:5';

  return (
    <div className="space-y-3" data-testid="exchange">
      {/* The request */}
      <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-studio-accent/20 px-4 py-3 text-sm text-white">
        <p className="whitespace-pre-wrap">{item.prompt}</p>
        {item.attachments.length > 0 && (
          <div className="mt-2 flex gap-2">
            {item.attachments.map((a) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={a.id}
                src={a.url}
                alt={a.name}
                title={`${a.name} (${a.usage})`}
                className="h-12 w-12 rounded object-cover"
              />
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {chips.map((c) => (
            <span key={c} className="rounded-full bg-black/25 px-2 py-0.5 text-[11px] text-zinc-300">
              {c}
            </span>
          ))}
        </div>
      </div>

      {/* The answer */}
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-studio-line bg-studio-panel p-4 text-sm">
        {active && (
          <div className="space-y-2" data-testid="exchange-progress">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-zinc-200">
                <Spinner /> {STAGE_LABEL[item.job?.stage ?? ''] ?? 'Queued…'}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void onCancel()}>
                Cancel
              </Button>
            </div>
            <ProgressBar value={item.job?.progress ?? 0} />
            {item.keyframes.length > 0 && (
              <div className="flex gap-2" data-testid="exchange-keyframes">
                {item.keyframes.map((k) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={k} src={k} alt="Keyframe" className="h-28 rounded-lg object-cover" />
                ))}
              </div>
            )}
            <p className="text-xs text-studio-muted">
              Usually 1–5 minutes{item.character ? ' (character videos take a little longer)' : ''}. You can
              leave this page; it keeps going.
            </p>
          </div>
        )}
        {!active && item.video && (
          <div className="space-y-3">
            <p className="font-medium text-white">{item.title}</p>
            <video
              src={item.video.url}
              poster={item.thumbnail?.url}
              controls
              playsInline
              data-testid="exchange-video"
              className={clsx('rounded-xl bg-black', portrait ? 'max-h-[70vh]' : 'w-full')}
            />
          </div>
        )}
        {!active && failed && (
          <p className="text-red-300" data-testid="exchange-error">
            {item.job?.status === 'cancelled'
              ? 'Cancelled.'
              : `Something went wrong: ${item.job?.error ?? 'unknown error'}`}
          </p>
        )}
        {!active && item.video && item.character && (
          <p className="mt-2 text-xs text-amber-200/90" data-testid="ai-label-reminder">
            Posting a realistic AI person? Turn on Instagram&apos;s <strong>AI info</strong> label (and
            TikTok&apos;s AI-generated label).
          </p>
        )}
        {!active && (
          <div className="mt-3 flex flex-wrap gap-2">
            {item.video && (
              <a href={item.video.downloadUrl}>
                <Button size="sm" variant="primary">
                  ⬇ Download
                </Button>
              </a>
            )}
            <Button size="sm" onClick={() => void onRetry()} data-testid="exchange-retry">
              ↻ Try again
            </Button>
            <Link href={`/projects/${item.id}/storyboard`}>
              <Button size="sm" variant="ghost">
                Open in advanced editor
              </Button>
            </Link>
            <ConfirmButton size="sm" variant="ghost" confirmLabel="Delete this video?" onConfirm={onDelete}>
              Delete
            </ConfirmButton>
          </div>
        )}
      </div>
    </div>
  );
}
