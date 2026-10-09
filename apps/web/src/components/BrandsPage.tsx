'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import {
  BRAND_ASSET_ROLES,
  FONTS,
  PALETTE_ROLES,
  emptyDesignSystem,
  type BrandInput,
  type DesignSystem,
} from '@studio/core/schemas';
import { apiGet, apiSend, uploadFile } from '@/lib/api';
import type { BrandAssetDTO, BrandDetailDTO, BrandDTO } from '@/lib/types';
import { formatBytes } from '@/lib/format';
import { BrandBoard } from './BrandBoard';
import { NewBrandFlow } from './NewBrandFlow';
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
  SectionTitle,
  Select,
  Spinner,
  Textarea,
  useAction,
} from './ui';

const EMPTY: BrandInput = {
  name: '',
  primaryColor: '#7C3AED',
  secondaryColor: '#111827',
  accentColor: '#F59E0B',
  headingFont: 'Montserrat',
  bodyFont: 'Roboto',
  introText: '',
  outroText: '',
  defaultCta: '',
  handles: { instagram: '', tiktok: '', youtube: '', facebook: '', website: '' },
};

export type Tab = 'overview' | 'design' | 'profile' | 'context';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'design', label: 'Edit design system' },
  { id: 'profile', label: 'Profile' },
  { id: 'context', label: 'AI context' },
];

const ROLE_LABEL = Object.fromEntries(BRAND_ASSET_ROLES.map((r) => [r.id, r.label])) as Record<
  string,
  string
>;
/** Uploads tagged "auto" are sorted by the next design-system run. */
const AUTO_ROLE = { id: 'auto', label: 'Not analysed yet' } as const;

export function BrandsPage({
  startNew = false,
  initialBrandId = null,
  initialTab = 'overview',
}: {
  startNew?: boolean;
  initialBrandId?: string | null;
  initialTab?: Tab;
}) {
  const router = useRouter();
  const [brands, setBrands] = useState<BrandDTO[]>([]);
  const [selected, setSelected] = useState<string | 'new' | null>(startNew ? 'new' : initialBrandId);
  const [detail, setDetail] = useState<BrandDetailDTO | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [manual, setManual] = useState(false);
  const { busy, run } = useAction();

  const loadList = useCallback(
    async () => setBrands((await apiGet<{ brands: BrandDTO[] }>('/api/brands')).brands),
    [],
  );
  const loadDetail = useCallback(
    async (id: string) => setDetail((await apiGet<{ brand: BrandDetailDTO }>(`/api/brands/${id}`)).brand),
    [],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selected && selected !== 'new') void loadDetail(selected);
    else setDetail(null);
  }, [selected, loadDetail]);

  // Poll while the design system is being generated.
  const generating =
    detail?.designStatus === 'generating' ||
    detail?.job?.status === 'queued' ||
    detail?.job?.status === 'running';
  useEffect(() => {
    if (!generating || !detail) return;
    const t = setInterval(() => void loadDetail(detail.id), 2000);
    return () => clearInterval(t);
  }, [generating, detail, loadDetail]);

  const onSaved = async (b: BrandDetailDTO) => {
    if (startNew) {
      // Created from the "New brand" menu: continue on the brand's page.
      router.push(`/brands?brand=${b.id}&tab=overview`);
      return;
    }
    setDetail(b);
    setSelected(b.id);
    await loadList();
  };

  return (
    <div>
      <SectionTitle
        title="Brand profiles"
        subtitle="Logos, imagery and a design system that the AI follows for every brief, storyboard, prompt and render."
        actions={
          <Button
            variant="primary"
            data-testid="new-brand"
            onClick={() => {
              setSelected('new');
              setManual(false);
              setTab('overview');
            }}
          >
            + New brand
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="space-y-2">
          {brands.length === 0 && selected !== 'new' && (
            <EmptyState title="No brands yet">
              Create one to reuse logos, colours and style across projects.
            </EmptyState>
          )}
          {brands.map((b) => (
            <button
              key={b.id}
              onClick={() => setSelected(b.id)}
              data-testid="brand-item"
              className={clsx(
                'card flex w-full items-center gap-3 p-3 text-left transition',
                selected === b.id ? 'border-studio-accent' : 'hover:border-studio-accent/50',
              )}
            >
              {b.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={b.logo.url} alt="" className="h-10 w-10 rounded bg-white/5 object-contain" />
              ) : (
                <span
                  className="h-10 w-10 shrink-0 rounded"
                  style={{ background: `linear-gradient(135deg, ${b.primaryColor}, ${b.accentColor})` }}
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-white">{b.name}</span>
                <span className="flex gap-1 pt-1">
                  {(b.designSystem?.palette.length
                    ? b.designSystem.palette.map((p) => p.hex)
                    : [b.primaryColor, b.secondaryColor, b.accentColor]
                  )
                    .slice(0, 6)
                    .map((c, i) => (
                      <span
                        key={`${c}-${i}`}
                        className="h-3 w-3 rounded-sm border border-white/10"
                        style={{ background: c }}
                      />
                    ))}
                </span>
              </span>
              <DesignStatusBadge status={b.designStatus} />
            </button>
          ))}
        </div>

        {selected === 'new' &&
          (manual ? (
            <ProfileForm onSaved={onSaved} busy={busy} run={run} />
          ) : (
            <NewBrandFlow
              onManual={() => setManual(true)}
              onDone={async (id) => {
                if (startNew) return router.push(`/brands?brand=${id}&tab=overview`);
                setTab('overview');
                setSelected(id);
                await loadList();
              }}
            />
          ))}

        {detail && (
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-studio-line px-5 pt-4">
              <h2 className="font-display text-lg font-semibold text-white">{detail.name}</h2>
              <DesignStatusBadge status={detail.designStatus} />
              <nav className="-mb-px flex w-full gap-1 overflow-x-auto">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    data-testid={`brand-tab-${t.id}`}
                    className={clsx(
                      'whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition',
                      tab === t.id
                        ? 'border-studio-accent text-white'
                        : 'border-transparent text-studio-muted hover:text-white',
                    )}
                  >
                    {t.label}
                    {t.id === 'overview' && detail.assets.length ? ` · ${detail.assets.length} assets` : ''}
                  </button>
                ))}
              </nav>
            </div>
            <div className="p-5">
              {tab === 'profile' && (
                <ProfileForm
                  key={detail.id}
                  brand={detail}
                  onSaved={onSaved}
                  busy={busy}
                  run={run}
                  onDeleted={async () => {
                    setSelected(null);
                    await loadList();
                  }}
                />
              )}
              {tab === 'overview' && (
                <BrandBoard
                  brand={detail}
                  onChange={onSaved}
                  generating={Boolean(generating)}
                  onEdit={() => setTab('design')}
                  assets={<AssetsPanel brand={detail} onChange={onSaved} />}
                />
              )}
              {tab === 'design' && (
                <DesignPanel
                  key={`${detail.id}-${detail.designStatus}`}
                  brand={detail}
                  onChange={onSaved}
                  generating={Boolean(generating)}
                />
              )}
              {tab === 'context' && <ContextPanel brand={detail} />}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function DesignStatusBadge({ status }: { status: string }) {
  if (status === 'approved') return <Badge status="approved">design approved</Badge>;
  if (status === 'draft') return <Badge status="limited">design draft</Badge>;
  if (status === 'generating') return <Badge status="running">generating</Badge>;
  return <Badge>no design system</Badge>;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function ProfileForm({
  brand,
  onSaved,
  onDeleted,
  busy,
  run,
}: {
  brand?: BrandDetailDTO;
  onSaved: (b: BrandDetailDTO) => Promise<void>;
  onDeleted?: () => Promise<void>;
  busy: string | null;
  run: ReturnType<typeof useAction>['run'];
}) {
  const [form, setForm] = useState<BrandInput>(() =>
    brand
      ? {
          name: brand.name,
          primaryColor: brand.primaryColor,
          secondaryColor: brand.secondaryColor,
          accentColor: brand.accentColor,
          headingFont: brand.headingFont as BrandInput['headingFont'],
          bodyFont: brand.bodyFont as BrandInput['bodyFont'],
          introText: brand.introText,
          outroText: brand.outroText,
          defaultCta: brand.defaultCta,
          handles: { ...EMPTY.handles, ...brand.handles },
        }
      : EMPTY,
  );

  const save = () =>
    run(
      'save',
      async () => {
        const handles = Object.fromEntries(Object.entries(form.handles).filter(([, v]) => v.trim()));
        let id = brand?.id;
        if (!id)
          id = (await apiSend<{ brand: BrandDTO }>('/api/brands', 'POST', { ...form, handles })).brand.id;
        const { brand: saved } = await apiSend<{ brand: BrandDetailDTO }>(`/api/brands/${id}`, 'PATCH', {
          ...form,
          handles,
        });
        await onSaved(saved);
      },
      'Brand saved',
    );

  const Wrapper = brand ? 'div' : Card;
  return (
    <Wrapper className={brand ? '' : 'p-5'}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Brand name" className="sm:col-span-2">
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            data-testid="brand-name"
          />
        </Field>
        {!brand?.designSystem &&
          (['primaryColor', 'secondaryColor', 'accentColor'] as const).map((k) => (
            <Field key={k} label={k.replace('Color', ' colour')} group>
              <ColorInput value={form[k]} label={k} onChange={(v) => setForm({ ...form, [k]: v })} />
            </Field>
          ))}
        {!brand?.designSystem && (
          <>
            <Field label="Heading font">
              <Select
                value={form.headingFont}
                onChange={(e) =>
                  setForm({ ...form, headingFont: e.target.value as BrandInput['headingFont'] })
                }
              >
                {FONTS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
            </Field>
            <Field label="Body font">
              <Select
                value={form.bodyFont}
                onChange={(e) => setForm({ ...form, bodyFont: e.target.value as BrandInput['bodyFont'] })}
              >
                {FONTS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
            </Field>
          </>
        )}
        {brand?.designSystem && (
          <p className="text-xs text-studio-muted sm:col-span-2">
            Colours and fonts are managed in the Design system tab.
          </p>
        )}
        <Field label="Default intro text">
          <Textarea
            rows={2}
            value={form.introText}
            onChange={(e) => setForm({ ...form, introText: e.target.value })}
          />
        </Field>
        <Field label="Default outro text">
          <Textarea
            rows={2}
            value={form.outroText}
            onChange={(e) => setForm({ ...form, outroText: e.target.value })}
          />
        </Field>
        <Field label="Default call to action" className="sm:col-span-2">
          <Input value={form.defaultCta} onChange={(e) => setForm({ ...form, defaultCta: e.target.value })} />
        </Field>
        {Object.keys(EMPTY.handles).map((h) => (
          <Field key={h} label={h}>
            <Input
              value={form.handles[h] ?? ''}
              onChange={(e) => setForm({ ...form, handles: { ...form.handles, [h]: e.target.value } })}
              placeholder={h === 'website' ? 'example.com' : '@handle'}
            />
          </Field>
        ))}
      </div>
      <div className="mt-5 flex justify-between gap-2">
        {brand && onDeleted ? (
          <ConfirmButton
            variant="ghost"
            confirmLabel="Delete brand and its assets?"
            onConfirm={async () => {
              await apiSend(`/api/brands/${brand.id}`, 'DELETE');
              await onDeleted();
            }}
          >
            Delete brand
          </ConfirmButton>
        ) : (
          <span />
        )}
        <Button
          variant="primary"
          onClick={save}
          loading={busy === 'save'}
          disabled={!form.name.trim()}
          data-testid="save-brand"
        >
          {brand ? 'Save profile' : 'Create brand'}
        </Button>
      </div>
    </Wrapper>
  );
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

function AssetsPanel({
  brand,
  onChange,
}: {
  brand: BrandDetailDTO;
  onChange: (b: BrandDetailDTO) => Promise<void>;
}) {
  const { busy, run } = useAction();
  const [role, setRole] = useState<string>(AUTO_ROLE.id);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setProgress(0);
      await run(
        `up-${f.name}`,
        async () => {
          const r = await uploadFile<{ brand: BrandDetailDTO }>(
            `/api/brands/${brand.id}/assets`,
            f,
            { role, label: f.name.replace(/\.[^.]+$/, '') },
            setProgress,
          );
          await onChange(r.brand);
        },
        `${f.name} uploaded`,
      );
    }
    setProgress(null);
  };

  const groups = [AUTO_ROLE, ...BRAND_ASSET_ROLES]
    .map((r) => ({ ...r, items: brand.assets.filter((a) => a.role === r.id) }))
    .filter((g) => g.items.length);

  return (
    <div className="space-y-5">
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
          'flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-dashed p-4 transition',
          dragOver ? 'border-studio-accent bg-studio-accent/10' : 'border-studio-line',
        )}
        data-testid="asset-dropzone"
      >
        <div className="text-sm">
          <p className="font-medium text-white">Drop logos, posters, product shots or guideline PDFs here</p>
          <p className="text-xs text-studio-muted">
            PNG with transparency works best for logos. Product and mood images guide scenes that have no
            image of their own.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-label="Asset type"
            data-testid="asset-role"
            className="!w-52"
          >
            <option value={AUTO_ROLE.id}>Let the AI decide</option>
            {BRAND_ASSET_ROLES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            onClick={() => input.current?.click()}
            loading={progress !== null}
            data-testid="upload-brand-asset"
          >
            Upload
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf,.txt,.md"
          data-testid="brand-asset-input"
          onChange={(e) => {
            if (e.target.files?.length) void upload(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {progress !== null && <ProgressBar value={progress} />}

      {brand.assets.length === 0 && (
        <EmptyState title="No assets yet">
          Start with your logo, then add posters, product or lifestyle images.
        </EmptyState>
      )}

      {groups.map((g) => (
        <div key={g.id}>
          <p className="mb-2 text-xs font-medium text-studio-muted">{g.label}</p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {g.items.map((a) => (
              <AssetCard key={a.id} brand={brand} asset={a} onChange={onChange} busy={busy} run={run} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AssetCard({
  brand,
  asset,
  onChange,
  busy,
  run,
}: {
  brand: BrandDetailDTO;
  asset: BrandAssetDTO;
  onChange: (b: BrandDetailDTO) => Promise<void>;
  busy: string | null;
  run: ReturnType<typeof useAction>['run'];
}) {
  const [notes, setNotes] = useState(asset.notes);
  const isImage = asset.mime.startsWith('image/');
  const patch = (body: Record<string, unknown>) =>
    run(`patch-${asset.id}`, async () =>
      onChange(
        (
          await apiSend<{ brand: BrandDetailDTO }>(
            `/api/brands/${brand.id}/assets/${asset.id}`,
            'PATCH',
            body,
          )
        ).brand,
      ),
    );

  return (
    <div
      className={clsx(
        'rounded-xl border p-3',
        asset.isOverlayLogo ? 'border-studio-accent' : 'border-studio-line',
      )}
      data-testid="brand-asset"
    >
      <div className="grid aspect-video place-items-center overflow-hidden rounded-lg bg-[repeating-conic-gradient(#1f1f2a_0%_25%,#15151d_0%_50%)] bg-[length:16px_16px]">
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.url} alt={asset.label} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-3xl">📄</span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate text-sm text-white" title={asset.name ?? ''}>
          {asset.label || asset.name}
        </span>
        {asset.isOverlayLogo && <Badge status="approved">overlay logo</Badge>}
      </div>
      <p className="text-xs text-studio-muted">
        {asset.mime} · {formatBytes(asset.sizeBytes)}
      </p>
      <div className="mt-2 grid gap-2">
        <Select value={asset.role} aria-label="Asset type" onChange={(e) => patch({ role: e.target.value })}>
          {asset.role === AUTO_ROLE.id && (
            <option value={AUTO_ROLE.id} disabled>
              {AUTO_ROLE.label}
            </option>
          )}
          {BRAND_ASSET_ROLES.map((r) => (
            <option key={r.id} value={r.id}>
              {ROLE_LABEL[r.id]}
            </option>
          ))}
        </Select>
        <Input
          aria-label="Notes for the AI"
          placeholder="Notes for the AI (e.g. hero product)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== asset.notes && patch({ notes })}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {isImage && !asset.isOverlayLogo && (
          <Button
            size="sm"
            loading={busy === `overlay-${asset.id}`}
            onClick={() =>
              run(
                `overlay-${asset.id}`,
                async () =>
                  onChange(
                    (
                      await apiSend<{ brand: BrandDetailDTO }>(`/api/brands/${brand.id}`, 'PATCH', {
                        logoAssetId: asset.id,
                      })
                    ).brand,
                  ),
                'Overlay logo updated',
              )
            }
          >
            Use as overlay logo
          </Button>
        )}
        <a href={asset.downloadUrl}>
          <Button size="sm" variant="ghost">
            ⬇
          </Button>
        </a>
        <ConfirmButton
          size="sm"
          variant="ghost"
          confirmLabel="Delete?"
          onConfirm={async () =>
            onChange(
              (
                await apiSend<{ brand: BrandDetailDTO }>(
                  `/api/brands/${brand.id}/assets/${asset.id}`,
                  'DELETE',
                )
              ).brand,
            )
          }
        >
          Delete
        </ConfirmButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Design system
// ---------------------------------------------------------------------------

function DesignPanel({
  brand,
  onChange,
  generating,
}: {
  brand: BrandDetailDTO;
  onChange: (b: BrandDetailDTO) => Promise<void>;
  generating: boolean;
}) {
  const { busy, run } = useAction();
  const [ds, setDs] = useState<DesignSystem>(() => brand.designSystem ?? seedFromBrand(brand));
  const [dirty, setDirty] = useState(false);
  const set = (next: DesignSystem) => {
    setDs(next);
    setDirty(true);
  };
  const failed = brand.job?.status === 'failed' ? brand.job : null;

  const save = (status?: 'draft' | 'approved') =>
    run(
      status ?? 'save',
      async () =>
        onChange(
          (
            await apiSend<{ brand: BrandDetailDTO }>(`/api/brands/${brand.id}`, 'PATCH', {
              designSystem: ds,
              designStatus: status ?? (brand.designStatus === 'approved' ? 'draft' : undefined),
            })
          ).brand,
        ).then(() => setDirty(false)),
      status === 'approved'
        ? 'Design system approved – it will be used for every project with this brand'
        : 'Design system saved',
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-studio-line bg-white/5 p-4">
        <div className="text-sm text-zinc-300">
          <p className="font-medium text-white">Generate from assets</p>
          <p className="text-xs text-studio-muted">
            The AI studies your {brand.assets.length} uploaded asset{brand.assets.length === 1 ? '' : 's'}{' '}
            (logos, imagery, guideline documents) and profile, then drafts a design system for you to edit and
            approve.
          </p>
        </div>
        <Button
          variant="primary"
          data-testid="generate-design"
          loading={busy === 'gen'}
          disabled={generating}
          onClick={() =>
            run(
              'gen',
              async () =>
                onChange(
                  (
                    await apiSend<{ brand: BrandDetailDTO }>(
                      `/api/brands/${brand.id}/design-system/generate`,
                      'POST',
                    )
                  ).brand,
                ),
              'Generating design system…',
            )
          }
        >
          {generating ? 'Generating…' : brand.designSystem ? 'Regenerate' : 'Generate design system'}
        </Button>
      </div>
      {generating && (
        <InfoNote>
          <span className="flex items-center gap-2">
            <Spinner /> Analysing logos and imagery… this usually takes 20–60 seconds.
          </span>
        </InfoNote>
      )}
      {failed && !generating && <ErrorNote>Design system generation failed: {failed.error}</ErrorNote>}

      <fieldset disabled={generating} className="space-y-6">
        <Field label="Brand essence">
          <Textarea
            rows={3}
            value={ds.summary}
            onChange={(e) => set({ ...ds, summary: e.target.value })}
            data-testid="ds-summary"
            placeholder="Who the brand is, what it stands for, how it should feel."
          />
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="label">Colour palette</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                set({
                  ...ds,
                  palette: [...ds.palette, { name: 'New colour', hex: '#FFFFFF', role: 'other', usage: '' }],
                })
              }
              disabled={ds.palette.length >= 16}
            >
              + Add colour
            </Button>
          </div>
          <div className="space-y-2" data-testid="ds-palette">
            {ds.palette.map((p, i) => (
              <div
                key={i}
                className="grid grid-cols-[auto_1fr] gap-2 rounded-lg border border-studio-line p-2 sm:grid-cols-[auto_140px_120px_130px_1fr_auto] sm:items-center"
              >
                <span className="h-9 w-9 rounded border border-white/10" style={{ background: p.hex }} />
                <Input
                  aria-label="Colour name"
                  value={p.name}
                  onChange={(e) =>
                    set({
                      ...ds,
                      palette: ds.palette.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    })
                  }
                />
                <ColorInput
                  label={`Colour ${i + 1}`}
                  value={p.hex}
                  onChange={(v) =>
                    set({ ...ds, palette: ds.palette.map((x, j) => (j === i ? { ...x, hex: v } : x)) })
                  }
                />
                <Select
                  aria-label="Colour role"
                  value={p.role}
                  onChange={(e) =>
                    set({
                      ...ds,
                      palette: ds.palette.map((x, j) =>
                        j === i ? { ...x, role: e.target.value as typeof p.role } : x,
                      ),
                    })
                  }
                >
                  {PALETTE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label="Usage"
                  placeholder="When to use it"
                  value={p.usage}
                  onChange={(e) =>
                    set({
                      ...ds,
                      palette: ds.palette.map((x, j) => (j === i ? { ...x, usage: e.target.value } : x)),
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Remove colour"
                  onClick={() => set({ ...ds, palette: ds.palette.filter((_, j) => j !== i) })}
                >
                  ✕
                </Button>
              </div>
            ))}
            {ds.palette.length === 0 && (
              <p className="text-sm text-studio-muted">
                No colours yet – generate from assets or add them manually.
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {(['headingFont', 'bodyFont', 'captionFont'] as const).map((k) => (
            <Field
              key={k}
              label={k === 'headingFont' ? 'Heading font' : k === 'bodyFont' ? 'Body font' : 'Caption font'}
            >
              <Select
                value={ds.typography[k]}
                onChange={(e) => set({ ...ds, typography: { ...ds.typography, [k]: e.target.value } })}
              >
                {FONTS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </Select>
            </Field>
          ))}
          <Field label="Typography notes" className="sm:col-span-3">
            <Input
              value={ds.typography.notes}
              onChange={(e) => set({ ...ds, typography: { ...ds.typography, notes: e.target.value } })}
              placeholder="e.g. Headings extra-bold uppercase, tight tracking"
            />
          </Field>
        </div>

        <div>
          <span className="label">Visual style (guides every generated scene)</span>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ['photography', 'Photography'],
                ['lighting', 'Lighting'],
                ['composition', 'Composition'],
                ['colourGrading', 'Colour grading'],
                ['motion', 'Camera motion'],
                ['textures', 'Textures & materials'],
              ] as const
            ).map(([k, label]) => (
              <Field key={k} label={label}>
                <Textarea
                  rows={2}
                  value={ds.visualStyle[k]}
                  onChange={(e) => set({ ...ds, visualStyle: { ...ds.visualStyle, [k]: e.target.value } })}
                />
              </Field>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tone of voice" className="sm:col-span-2">
            <Textarea
              rows={2}
              value={ds.toneOfVoice.description}
              onChange={(e) =>
                set({ ...ds, toneOfVoice: { ...ds.toneOfVoice, description: e.target.value } })
              }
            />
          </Field>
          <ListField
            label="Tone keywords"
            values={ds.toneOfVoice.keywords}
            onChange={(v) => set({ ...ds, toneOfVoice: { ...ds.toneOfVoice, keywords: v } })}
          />
          <ListField
            label="Example phrases"
            values={ds.toneOfVoice.examplePhrases}
            onChange={(v) => set({ ...ds, toneOfVoice: { ...ds.toneOfVoice, examplePhrases: v } })}
          />
          <ListField label="Do" values={ds.dos} onChange={(v) => set({ ...ds, dos: v })} />
          <ListField label="Don't" values={ds.donts} onChange={(v) => set({ ...ds, donts: v })} />
          <ListField label="Taglines" values={ds.taglines} onChange={(v) => set({ ...ds, taglines: v })} />
          <ListField
            label="Words to avoid"
            values={ds.wordsToAvoid}
            onChange={(v) => set({ ...ds, wordsToAvoid: v })}
          />
          <Field label="Logo usage" className="sm:col-span-2">
            <Textarea
              rows={2}
              value={ds.logoUsage}
              onChange={(e) => set({ ...ds, logoUsage: e.target.value })}
            />
          </Field>
          <ListField
            label="Video prompt keywords (added to every generation)"
            values={ds.promptKeywords}
            onChange={(v) => set({ ...ds, promptKeywords: v })}
            testId="ds-keywords"
          />
          <Field label="Negative prompt (things the video model must avoid)">
            <Textarea
              rows={3}
              value={ds.negativePrompt}
              onChange={(e) => set({ ...ds, negativePrompt: e.target.value })}
            />
          </Field>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-studio-line pt-4">
        {dirty && <span className="text-xs text-amber-300">Unsaved changes</span>}
        <Button
          onClick={() => save()}
          disabled={!dirty || generating}
          loading={busy === 'save'}
          data-testid="save-design"
        >
          Save draft
        </Button>
        <Button
          variant="primary"
          onClick={() => save('approved')}
          disabled={generating}
          loading={busy === 'approved'}
          data-testid="approve-design"
        >
          {brand.designStatus === 'approved' && !dirty ? 'Approved ✓' : 'Approve design system'}
        </Button>
      </div>
    </div>
  );
}

function seedFromBrand(b: BrandDetailDTO): DesignSystem {
  const ds = emptyDesignSystem();
  ds.palette = [
    { name: 'Primary', hex: b.primaryColor, role: 'primary', usage: '' },
    { name: 'Secondary', hex: b.secondaryColor, role: 'secondary', usage: '' },
    { name: 'Accent', hex: b.accentColor, role: 'accent', usage: '' },
  ];
  ds.typography.headingFont = b.headingFont as DesignSystem['typography']['headingFont'];
  ds.typography.bodyFont = b.bodyFont as DesignSystem['typography']['bodyFont'];
  return ds;
}

function ListField({
  label,
  values,
  onChange,
  testId,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  testId?: string;
}) {
  const [text, setText] = useState(values.join('\n'));
  useEffect(() => setText(values.join('\n')), [values]);
  return (
    <Field label={label} hint="One per line">
      <Textarea
        rows={3}
        value={text}
        data-testid={testId}
        onChange={(e) => setText(e.target.value)}
        onBlur={() =>
          onChange(
            text
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      />
    </Field>
  );
}

function ColorInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label={`${label} picker`}
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="h-9 w-10 shrink-0 cursor-pointer rounded border border-studio-line bg-transparent"
      />
      <Input
        aria-label={`${label} hex`}
        value={text}
        className="font-mono text-xs"
        onChange={(e) => {
          setText(e.target.value);
          if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toUpperCase());
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI context preview
// ---------------------------------------------------------------------------

function ContextPanel({ brand }: { brand: BrandDetailDTO }) {
  return (
    <div className="space-y-3">
      <InfoNote>
        This is exactly what the language model receives about this brand when writing briefs, storyboards and
        video prompts. Video generation also appends the prompt keywords and uses the negative prompt;
        captions and intro/outro cards use the palette and fonts; the overlay logo is added during rendering.
      </InfoNote>
      <pre
        className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-xl border border-studio-line bg-black/40 p-4 font-mono text-xs leading-relaxed text-zinc-200"
        data-testid="brand-guide"
      >
        {brand.guide}
      </pre>
      {brand.designStatus !== 'approved' && (
        <p className="text-xs text-amber-300">
          The design system is not approved yet – drafts are still used, but review it before generating
          videos.
        </p>
      )}
    </div>
  );
}
