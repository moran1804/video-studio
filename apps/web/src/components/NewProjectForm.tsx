'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ASPECT_RATIOS, PLATFORMS, VIDEO_PROVIDER_LABELS, VIDEO_PROVIDERS } from '@studio/core/schemas';
import { apiGet, apiSend, uploadFile } from '@/lib/api';
import type { BrandDTO, ProjectBundle } from '@/lib/types';
import { BrandPicker } from './BrandPicker';
import { Button, Card, ErrorNote, Field, Input, SectionTitle, Select, Textarea, Toggle } from './ui';

const RATIO_FOR_PLATFORM: Record<string, string> = {
  instagram_reels: '9:16',
  tiktok: '9:16',
  youtube_shorts: '9:16',
  facebook_instagram_promo: '4:5',
  landscape_promo: '16:9',
};

const RATIO_HINT: Record<string, string> = {
  '9:16': '1080 × 1920 – Reels, TikTok, Shorts',
  '1:1': '1080 × 1080 – feed posts',
  '4:5': '1080 × 1350 – Instagram / Facebook feed',
  '16:9': '1920 × 1080 – YouTube, web, landscape promos',
};

export function NewProjectForm({
  brands: initialBrands,
  defaultProvider,
}: {
  brands: BrandDTO[];
  defaultProvider: string;
}) {
  const router = useRouter();
  const [brands, setBrands] = useState(initialBrands);
  const [useBrand, setUseBrand] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [artwork, setArtwork] = useState<{ file: File; url: string; mode: 'animate' | 'inspiration' }[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const artworkInput = useRef<HTMLInputElement>(null);
  // Free preview URLs only when leaving the page (removals revoke their own URL).
  const artworkRef = useRef(artwork);
  artworkRef.current = artwork;
  useEffect(() => () => artworkRef.current.forEach((a) => URL.revokeObjectURL(a.url)), []);
  const addArtwork = (list: FileList) => {
    // Copy now: the input is cleared right after, which empties the live FileList.
    const files = Array.from(list).filter((f) => f.type.startsWith('image/'));
    setArtwork((cur) => [
      ...cur,
      ...files.map((file) => ({ file, url: URL.createObjectURL(file), mode: 'animate' as const })),
    ]);
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '',
    platform: 'instagram_reels',
    aspectRatio: '9:16',
    durationSec: 30,
    brandId: '',
    defaultProvider: '',
    objective: '',
    audience: '',
    tone: '',
    mainMessage: '',
    callToAction: '',
    eventDetails: '',
    brandInfo: '',
    additionalContext: '',
    voiceoverPreference: '',
    musicPreference: '',
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (useBrand && !form.brandId) {
      setError('Pick a brand, or switch "Use a brand" off.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { id } = await apiSend<{ id: string }>('/api/projects', 'POST', {
        name: form.name,
        platform: form.platform,
        aspectRatio: form.aspectRatio,
        durationSec: Number(form.durationSec),
        brandId: useBrand && form.brandId ? form.brandId : null,
        defaultProvider: form.defaultProvider || null,
        details: {
          objective: form.objective,
          audience: form.audience,
          tone: form.tone,
          mainMessage: form.mainMessage,
          callToAction: form.callToAction,
          eventDetails: form.eventDetails,
          brandInfo: form.brandInfo,
          additionalContext: form.additionalContext,
          voiceoverPreference: form.voiceoverPreference,
          musicPreference: form.musicPreference,
        },
      });
      // Upload artwork; images to animate get a ready-to-generate scene each.
      let animated = 0;
      for (const [i, a] of artwork.entries()) {
        setProgress(`Uploading ${i + 1} of ${artwork.length}: ${a.file.name}`);
        const b = await uploadFile<ProjectBundle>(`/api/projects/${id}/references`, a.file, {
          title: a.file.name,
          usage: a.mode,
        });
        if (a.mode === 'animate') {
          const ref = b.references.filter((r) => r.title === a.file.name && r.usage === 'animate').at(-1);
          if (ref) {
            await apiSend(`/api/references/${ref.id}/animate-scene`, 'POST', {});
            animated++;
          }
        }
      }
      router.push(animated ? `/projects/${id}/storyboard` : `/projects/${id}/references`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project');
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto max-w-4xl space-y-6" data-testid="new-project-form">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">New project</h1>
        <p className="mt-1 text-sm text-studio-muted">
          Tell the studio what you want to make. You can refine everything later.
        </p>
      </div>

      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Project name" className="sm:col-span-2">
          <Input
            name="name"
            required
            maxLength={200}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Summer launch party teaser"
          />
        </Field>
        <Field label="Platform">
          <Select
            name="platform"
            value={form.platform}
            onChange={(e) => {
              set('platform', e.target.value);
              set('aspectRatio', RATIO_FOR_PLATFORM[e.target.value] ?? '9:16');
            }}
          >
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Aspect ratio" hint={RATIO_HINT[form.aspectRatio]} group>
          <div className="grid grid-cols-4 gap-2">
            {ASPECT_RATIOS.map((r) => (
              <button
                type="button"
                key={r}
                onClick={() => set('aspectRatio', r)}
                aria-pressed={form.aspectRatio === r}
                className={`rounded-lg border px-2 py-2 text-sm transition ${form.aspectRatio === r ? 'border-studio-accent bg-studio-accent/15 text-white' : 'border-studio-line text-zinc-400 hover:text-white'}`}
              >
                {r}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Desired duration (seconds)">
          <Input
            name="durationSec"
            type="number"
            min={5}
            max={180}
            value={form.durationSec}
            onChange={(e) => set('durationSec', Number(e.target.value))}
          />
        </Field>
        <Field label="Video generation provider">
          <Select
            name="defaultProvider"
            value={form.defaultProvider}
            onChange={(e) => set('defaultProvider', e.target.value)}
          >
            <option value="">
              Studio default (
              {VIDEO_PROVIDER_LABELS[defaultProvider as keyof typeof VIDEO_PROVIDER_LABELS] ??
                defaultProvider}
              )
            </option>
            {VIDEO_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {VIDEO_PROVIDER_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
      </Card>

      <Card className="p-5" data-testid="artwork-section">
        <SectionTitle
          title="Artwork (optional)"
          subtitle="Got a poster, flyer or image you want brought to life? Add it here – no brand or brief needed. You can add more references later."
          actions={
            <Button
              type="button"
              size="sm"
              onClick={() => artworkInput.current?.click()}
              data-testid="add-artwork"
            >
              + Add images
            </Button>
          }
        />
        <input
          ref={artworkInput}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          data-testid="artwork-input"
          onChange={(e) => {
            if (e.target.files?.length) addArtwork(e.target.files);
            e.target.value = '';
          }}
        />
        {artwork.length === 0 ? (
          <button
            type="button"
            onClick={() => artworkInput.current?.click()}
            className="w-full rounded-xl border-2 border-dashed border-studio-line px-4 py-6 text-sm text-studio-muted transition hover:border-studio-accent/60 hover:text-white"
          >
            e.g. &ldquo;animate this poster&rdquo; – click to choose images
          </button>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {artwork.map((a, i) => (
              <div
                key={a.url}
                className="flex gap-3 rounded-xl border border-studio-line p-3"
                data-testid="artwork-item"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt="" className="h-20 w-16 shrink-0 rounded object-cover" />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="truncate text-sm text-white" title={a.file.name}>
                    {a.file.name}
                  </p>
                  <Select
                    aria-label={`How to use ${a.file.name}`}
                    value={a.mode}
                    onChange={(e) =>
                      setArtwork((cur) =>
                        cur.map((x, j) =>
                          j === i ? { ...x, mode: e.target.value as 'animate' | 'inspiration' } : x,
                        ),
                      )
                    }
                  >
                    <option value="animate">Animate this image</option>
                    <option value="inspiration">Use as inspiration</option>
                  </Select>
                  <button
                    type="button"
                    className="text-xs text-studio-muted hover:text-red-300"
                    onClick={() => {
                      URL.revokeObjectURL(a.url);
                      setArtwork((cur) => cur.filter((_, j) => j !== i));
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5" data-testid="branding-section">
        <SectionTitle
          title="Branding (optional)"
          subtitle="Apply one of your brands so the AI follows its logo, colours, fonts, visual style and tone. You can change this later."
        />
        <Toggle
          label="Use a brand / design system"
          checked={useBrand}
          onChange={(v) => {
            setUseBrand(v);
            if (!v) set('brandId', '');
            else if (!form.brandId && brands.length === 1) set('brandId', brands[0]!.id);
          }}
        />
        {useBrand && (
          <div className="mt-4 space-y-3">
            {brands.length === 0 && (
              <p className="text-sm text-studio-muted">
                You haven&apos;t created a brand yet. Create one in a new tab, then click Refresh list.
              </p>
            )}
            <BrandPicker brands={brands} value={form.brandId || null} onChange={(id) => set('brandId', id)} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-studio-muted">
                {form.brandId
                  ? `Using ${brands.find((b) => b.id === form.brandId)?.name ?? 'brand'}.`
                  : 'Select a brand above.'}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                loading={refreshing}
                data-testid="refresh-brands"
                onClick={async () => {
                  setRefreshing(true);
                  try {
                    setBrands((await apiGet<{ brands: BrandDTO[] }>('/api/brands')).brands);
                  } finally {
                    setRefreshing(false);
                  }
                }}
              >
                ↻ Refresh list
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Video objective">
          <Textarea
            name="objective"
            value={form.objective}
            onChange={(e) => set('objective', e.target.value)}
            placeholder="Drive ticket sales for our summer party"
          />
        </Field>
        <Field label="Target audience">
          <Textarea
            name="audience"
            value={form.audience}
            onChange={(e) => set('audience', e.target.value)}
            placeholder="18–30 year olds who love house music"
          />
        </Field>
        <Field label="Tone & visual style">
          <Textarea
            name="tone"
            value={form.tone}
            onChange={(e) => set('tone', e.target.value)}
            placeholder="Energetic, neon, cinematic night-time, sweaty dance floor"
          />
        </Field>
        <Field label="Main message">
          <Textarea
            name="mainMessage"
            value={form.mainMessage}
            onChange={(e) => set('mainMessage', e.target.value)}
            placeholder="The biggest rooftop party of the summer is back"
          />
        </Field>
        <Field label="Call to action">
          <Input
            name="callToAction"
            value={form.callToAction}
            onChange={(e) => set('callToAction', e.target.value)}
            placeholder="Get tickets – link in bio"
          />
        </Field>
        <Field label="Voiceover preference">
          <Input
            name="voiceoverPreference"
            value={form.voiceoverPreference}
            onChange={(e) => set('voiceoverPreference', e.target.value)}
            placeholder="Female, confident, British – or 'no voiceover'"
          />
        </Field>
        <Field label="Event details">
          <Textarea
            name="eventDetails"
            value={form.eventDetails}
            onChange={(e) => set('eventDetails', e.target.value)}
            placeholder="Saturday 12 July, 8pm–2am, Skyline Rooftop, London"
          />
        </Field>
        <Field label="Brand information">
          <Textarea
            name="brandInfo"
            value={form.brandInfo}
            onChange={(e) => set('brandInfo', e.target.value)}
            placeholder="Who you are, values, anything the video should respect"
          />
        </Field>
        <Field label="Music preference">
          <Input
            name="musicPreference"
            value={form.musicPreference}
            onChange={(e) => set('musicPreference', e.target.value)}
            placeholder="Uplifting deep house, 124 BPM (licensed track uploaded later)"
          />
        </Field>
        <Field label="Additional context">
          <Textarea
            name="additionalContext"
            value={form.additionalContext}
            onChange={(e) => set('additionalContext', e.target.value)}
            placeholder="Anything else: must-have shots, things to avoid, headliners…"
          />
        </Field>
      </Card>

      {error && <ErrorNote>{error}</ErrorNote>}
      {progress && <p className="text-right text-xs text-studio-muted">{progress}</p>}
      <div className="flex justify-end gap-3">
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} data-testid="create-project">
          Create project & add references →
        </Button>
      </div>
    </form>
  );
}
