'use client';

import { useState } from 'react';
import { apiSend } from '@/lib/api';
import type { BrandDetailDTO } from '@/lib/types';
import { Badge, Button, ErrorNote, InfoNote, Spinner, useAction } from './ui';

const fontAlias = (family: string) => `brand-${family.replace(/\s+/g, '-').toLowerCase()}`;

/** @font-face rules for the brand fonts, served by /api/fonts (same files the renderer uses). */
function FontFaces({ families }: { families: string[] }) {
  const css = [...new Set(families)]
    .flatMap((f) =>
      (['regular', 'bold'] as const).map(
        (w) =>
          `@font-face{font-family:'${fontAlias(f)}';src:url('/api/fonts/${encodeURIComponent(f)}?weight=${w}');font-weight:${w === 'bold' ? 700 : 400};font-display:swap}`,
      ),
    )
    .join('');
  return <style>{css}</style>;
}

/**
 * The brand at a glance – logo, palette, typography, style and tone – plus the
 * asset library (passed in as `assets`). The default view of a brand.
 */
export function BrandBoard({
  brand,
  onChange,
  generating,
  assets,
  onEdit,
}: {
  brand: BrandDetailDTO;
  onChange: (b: BrandDetailDTO) => Promise<void>;
  generating: boolean;
  assets: React.ReactNode;
  onEdit: () => void;
}) {
  const { busy, run } = useAction();
  const [copied, setCopied] = useState<string | null>(null);
  const ds = brand.designSystem;
  const failed = brand.job?.status === 'failed' ? brand.job.error : null;
  const palette = ds?.palette.length
    ? ds.palette
    : [
        { name: 'Primary', hex: brand.primaryColor, role: 'primary', usage: '' },
        { name: 'Secondary', hex: brand.secondaryColor, role: 'secondary', usage: '' },
        { name: 'Accent', hex: brand.accentColor, role: 'accent', usage: '' },
      ];
  const heading = ds?.typography.headingFont ?? brand.headingFont;
  const body = ds?.typography.bodyFont ?? brand.bodyFont;
  const caption = ds?.typography.captionFont ?? heading;
  const accent = palette.find((p) => p.role === 'accent')?.hex ?? brand.accentColor;
  const unsorted = brand.assets.filter((a) => a.role === 'auto').length;

  const regenerate = () =>
    run(
      'regen',
      async () =>
        onChange(
          (
            await apiSend<{ brand: BrandDetailDTO }>(
              `/api/brands/${brand.id}/design-system/generate`,
              'POST',
              {
                mode: ds ? 'refresh' : 'create',
              },
            )
          ).brand,
        ),
      'Analysing your assets…',
    );

  return (
    <div className="space-y-6" data-testid="brand-board">
      <FontFaces families={[heading, body, caption]} />

      {/* Header */}
      <div className="flex flex-wrap items-center gap-5">
        <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-2xl bg-[repeating-conic-gradient(#1f1f2a_0%_25%,#15151d_0%_50%)] bg-[length:14px_14px] p-2">
          {brand.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={brand.logo.url}
              alt={`${brand.name} logo`}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span
              className="h-full w-full rounded-xl"
              style={{ background: `linear-gradient(135deg, ${palette[0]?.hex}, ${accent})` }}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3
            className="truncate text-2xl font-bold text-white"
            style={{ fontFamily: `'${fontAlias(heading)}', sans-serif` }}
          >
            {brand.name}
          </h3>
          {ds?.summary && <p className="mt-1 max-w-2xl text-sm text-zinc-300">{ds.summary}</p>}
          {(brand.defaultCta || Object.values(brand.handles).some(Boolean)) && (
            <p className="mt-1 text-xs text-studio-muted">
              {[brand.defaultCta, ...Object.values(brand.handles).filter(Boolean)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={regenerate}
            loading={busy === 'regen'}
            disabled={generating || brand.assets.length === 0}
            data-testid="board-regenerate"
          >
            ✨ {ds ? 'Regenerate from assets' : 'Build design system'}
          </Button>
          {ds && brand.designStatus !== 'approved' && (
            <Button
              variant="primary"
              disabled={generating}
              loading={busy === 'approve'}
              data-testid="board-approve"
              onClick={() =>
                run(
                  'approve',
                  async () =>
                    onChange(
                      (
                        await apiSend<{ brand: BrandDetailDTO }>(`/api/brands/${brand.id}`, 'PATCH', {
                          designSystem: ds,
                          designStatus: 'approved',
                        })
                      ).brand,
                    ),
                  'Brand approved – the AI will follow it',
                )
              }
            >
              Approve
            </Button>
          )}
          {brand.designStatus === 'approved' && <Badge status="approved">approved ✓</Badge>}
        </div>
      </div>

      {generating && (
        <InfoNote>
          <span className="flex items-center gap-2">
            <Spinner /> Analysing your assets and writing the style guide… usually 20–60 seconds.
          </span>
        </InfoNote>
      )}
      {failed && !generating && <ErrorNote>Building the brand failed: {failed}</ErrorNote>}
      {unsorted > 0 && !generating && (
        <InfoNote>
          {unsorted} new upload{unsorted === 1 ? '' : 's'} not analysed yet.{' '}
          <button type="button" className="underline" onClick={regenerate}>
            Analyse now
          </button>{' '}
          to sort {unsorted === 1 ? 'it' : 'them'} and refresh the style guide.
        </InfoNote>
      )}

      {/* Palette */}
      <section>
        <p className="label mb-2">Colour palette</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="board-palette">
          {palette.map((p, i) => (
            <button
              key={`${p.hex}-${i}`}
              type="button"
              title="Copy hex"
              onClick={() => {
                void navigator.clipboard?.writeText(p.hex);
                setCopied(p.hex);
                setTimeout(() => setCopied(null), 1500);
              }}
              className="overflow-hidden rounded-xl border border-studio-line text-left transition hover:border-studio-accent/60"
            >
              <div className="h-20" style={{ background: p.hex }} />
              <div className="p-2">
                <p className="truncate text-sm font-medium text-white">{p.name}</p>
                <p className="font-mono text-xs text-studio-muted">{copied === p.hex ? 'copied!' : p.hex}</p>
                <p className="truncate text-[11px] text-studio-muted">
                  {p.role}
                  {p.usage ? ` · ${p.usage}` : ''}
                </p>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Typography */}
      <section>
        <p className="label mb-2">Typography</p>
        <div className="grid gap-3 md:grid-cols-3" data-testid="board-type">
          {(
            [
              ['Headings', heading, 700, 'Aa'],
              ['Body', body, 400, 'Aa'],
              ['Captions', caption, 700, 'Aa'],
            ] as const
          ).map(([label, family, weight, sample]) => (
            <div key={label} className="rounded-xl border border-studio-line p-4">
              <p className="text-xs text-studio-muted">
                {label} · {family}
              </p>
              <p
                className="text-5xl text-white"
                style={{ fontFamily: `'${fontAlias(family)}', sans-serif`, fontWeight: weight }}
              >
                {sample}
              </p>
              <p
                className="mt-1 truncate text-sm text-zinc-300"
                style={{ fontFamily: `'${fontAlias(family)}', sans-serif`, fontWeight: weight }}
              >
                {label === 'Body' ? 'The quick brown fox jumps over the lazy dog.' : brand.name}
              </p>
            </div>
          ))}
        </div>
        {/* Caption preview in the burned-in "bold social" style */}
        <div
          className="mt-3 grid place-items-center rounded-xl p-6"
          style={{ background: palette[0]?.hex ?? '#111' }}
        >
          <p
            className="text-center text-2xl uppercase tracking-wide text-white"
            style={{
              fontFamily: `'${fontAlias(caption)}', sans-serif`,
              fontWeight: 700,
              textShadow: '0 0 4px #000, 2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000',
            }}
          >
            {(ds?.taglines[0] || brand.defaultCta || `This is ${brand.name}`)
              .split(/\s+/)
              .slice(0, 6)
              .map((w, i) => (
                <span key={i} style={i === 1 ? { color: accent } : undefined}>
                  {w}{' '}
                </span>
              ))}
          </p>
        </div>
        {ds?.typography.notes && <p className="mt-2 text-xs text-studio-muted">{ds.typography.notes}</p>}
      </section>

      {/* Style and tone */}
      {ds && (
        <section className="grid gap-3 md:grid-cols-2">
          <div className="rounded-xl border border-studio-line p-4 text-sm">
            <p className="label mb-2">Visual style</p>
            <dl className="space-y-1.5 text-zinc-300">
              {(
                [
                  ['Photography', ds.visualStyle.photography],
                  ['Lighting', ds.visualStyle.lighting],
                  ['Colour grade', ds.visualStyle.colourGrading],
                  ['Camera motion', ds.visualStyle.motion],
                ] as const
              )
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k}>
                    <dt className="inline text-studio-muted">{k}: </dt>
                    <dd className="inline">{v}</dd>
                  </div>
                ))}
            </dl>
            {ds.promptKeywords.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {ds.promptKeywords.map((k) => (
                  <span key={k} className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-zinc-300">
                    {k}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-xl border border-studio-line p-4 text-sm">
            <p className="label mb-2">Tone of voice</p>
            <p className="text-zinc-300">{ds.toneOfVoice.description || '—'}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium text-emerald-300">Do</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-zinc-300">
                  {ds.dos.slice(0, 6).map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs font-medium text-red-300">Don&apos;t</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-zinc-300">
                  {ds.donts.slice(0, 6).map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>
      )}
      {ds && (
        <p className="text-right text-xs">
          <button
            type="button"
            onClick={onEdit}
            className="text-studio-muted underline-offset-2 hover:text-white hover:underline"
          >
            Edit colours, fonts, style and tone →
          </button>
        </p>
      )}

      {/* Asset library */}
      <section>
        <p className="label mb-2">Logos &amp; assets</p>
        {assets}
      </section>
    </div>
  );
}
