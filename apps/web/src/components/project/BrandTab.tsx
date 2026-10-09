'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { BrandingSettings } from '@studio/core/schemas';
import { apiGet, apiSend } from '@/lib/api';
import type { BrandDTO, ProjectBundle } from '@/lib/types';
import { Button, Card, Field, Input, SectionTitle, Select, Slider, Toggle, useAction } from '../ui';
import { useProject } from './ProjectContext';

export function BrandTab() {
  const { bundle, setBundle } = useProject();
  const p = bundle.project;
  const { busy, run } = useAction();
  const [brands, setBrands] = useState<BrandDTO[]>([]);
  const [b, setB] = useState<BrandingSettings>(p.brandingSettings);
  useEffect(() => setB(p.brandingSettings), [p.brandingSettings]);
  useEffect(() => {
    apiGet<{ brands: BrandDTO[] }>('/api/brands')
      .then((r) => setBrands(r.brands))
      .catch(() => undefined);
  }, []);
  const brand = bundle.brand;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="p-5">
        <SectionTitle
          title="Brand profile"
          subtitle="Colours, fonts, logo, intro/outro text and handles."
          actions={
            <Link href="/brands">
              <Button size="sm" variant="ghost">
                Manage brands →
              </Button>
            </Link>
          }
        />
        <Field label="Brand used by this project">
          <Select
            value={p.brandId ?? ''}
            onChange={(e) =>
              run(
                'brand',
                async () =>
                  setBundle(
                    await apiSend<ProjectBundle>(`/api/projects/${p.id}`, 'PATCH', {
                      brandId: e.target.value || null,
                    }),
                  ),
                'Brand updated',
              )
            }
          >
            <option value="">No brand</option>
            {brands.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        {brand ? (
          <div className="mt-4 flex items-center gap-4 rounded-xl border border-studio-line p-4">
            {brand.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brand.logo.url} alt="" className="h-14 w-14 rounded bg-white/5 object-contain" />
            ) : (
              <div className="grid h-14 w-14 place-items-center rounded bg-white/5 text-xs text-studio-muted">
                No logo
              </div>
            )}
            <div className="min-w-0">
              <div className="font-semibold text-white" data-testid="project-brand-name">
                {brand.name}
              </div>
              <div className="mt-1 flex gap-1">
                {(brand.designSystem?.palette.length
                  ? brand.designSystem.palette.map((p) => p.hex)
                  : [brand.primaryColor, brand.secondaryColor, brand.accentColor]
                ).map((c) => (
                  <span
                    key={c}
                    className="h-5 w-5 rounded border border-white/10"
                    style={{ background: c }}
                    title={c}
                  />
                ))}
              </div>
              <div className="mt-1 truncate text-xs text-studio-muted">
                {brand.headingFont} / {brand.bodyFont} ·{' '}
                {Object.values(brand.handles).filter(Boolean).join(' · ')}
              </div>
              <div className="mt-1 text-xs">
                {brand.designStatus === 'approved' ? (
                  <span className="text-emerald-300">
                    Design system approved – the AI follows it for this project.
                  </span>
                ) : brand.designStatus === 'draft' ? (
                  <span className="text-amber-300">
                    Design system is a draft – review and approve it under Brand profiles.
                  </span>
                ) : (
                  <span className="text-studio-muted">
                    No design system yet – generate one under Brand profiles for more on-brand videos.
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm text-studio-muted">
            Without a brand, intro/outro cards use the project name and call to action.
          </p>
        )}
      </Card>

      <Card className="p-5">
        <SectionTitle title="Overlays & cards" />
        <div className="space-y-4">
          <Toggle
            label="Show logo overlay"
            checked={b.showLogo}
            onChange={(v) => setB({ ...b, showLogo: v })}
            disabled={!brand?.logo}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Logo position">
              <Select
                value={b.logoPosition}
                onChange={(e) =>
                  setB({ ...b, logoPosition: e.target.value as BrandingSettings['logoPosition'] })
                }
              >
                <option value="top-left">Top left</option>
                <option value="top-right">Top right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="bottom-right">Bottom right</option>
              </Select>
            </Field>
            <Slider
              label="Logo size"
              value={b.logoScale}
              min={0.05}
              max={0.5}
              step={0.01}
              onChange={(v) => setB({ ...b, logoScale: v })}
              format={(v) => `${Math.round(v * 100)}% width`}
            />
            <Slider
              label="Logo opacity"
              value={b.logoOpacity}
              min={0.1}
              max={1}
              step={0.05}
              onChange={(v) => setB({ ...b, logoOpacity: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <Slider
              label="Card duration"
              value={b.cardDurationSec}
              min={1}
              max={6}
              step={0.5}
              onChange={(v) => setB({ ...b, cardDurationSec: v })}
              format={(v) => `${v}s`}
            />
          </div>
          <Field label="Watermark text (optional)">
            <Input
              value={b.watermarkText}
              maxLength={100}
              onChange={(e) => setB({ ...b, watermarkText: e.target.value })}
              placeholder="@yourhandle"
            />
          </Field>
          <Slider
            label="Watermark opacity"
            value={b.watermarkOpacity}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(v) => setB({ ...b, watermarkOpacity: v })}
            format={(v) => `${Math.round(v * 100)}%`}
          />
          <Toggle label="Intro card" checked={b.intro} onChange={(v) => setB({ ...b, intro: v })} />
          <Toggle
            label="Outro card with call to action"
            checked={b.outro}
            onChange={(v) => setB({ ...b, outro: v })}
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={() =>
                run(
                  'save',
                  async () =>
                    setBundle(
                      await apiSend<ProjectBundle>(`/api/projects/${p.id}`, 'PATCH', { brandingSettings: b }),
                    ),
                  'Branding saved',
                )
              }
              loading={busy === 'save'}
              data-testid="save-branding"
            >
              Save branding
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
