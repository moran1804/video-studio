'use client';

import clsx from 'clsx';
import type { BrandDTO } from '@/lib/types';
import { Badge } from './ui';

const STATUS: Record<string, { status: string; label: string }> = {
  approved: { status: 'approved', label: 'design system approved' },
  draft: { status: 'limited', label: 'design system draft' },
  generating: { status: 'running', label: 'generating' },
  none: { status: 'draft', label: 'no design system' },
};

/** Selectable brand cards with logo, palette and design-system status. */
export function BrandPicker({
  brands,
  value,
  onChange,
  createHref = '/brands/new',
}: {
  brands: BrandDTO[];
  value: string | null;
  onChange: (id: string) => void;
  createHref?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Brand"
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      data-testid="brand-picker"
    >
      {brands.map((b) => {
        const selected = value === b.id;
        const colors = b.designSystem?.palette.length
          ? b.designSystem.palette.map((p) => p.hex)
          : [b.primaryColor, b.secondaryColor, b.accentColor];
        const s = STATUS[b.designStatus] ?? STATUS.none!;
        return (
          <button
            key={b.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(b.id)}
            data-testid="brand-option"
            className={clsx(
              'flex items-center gap-3 rounded-xl border p-3 text-left transition',
              selected
                ? 'border-studio-accent bg-studio-accent/10 shadow-glow'
                : 'border-studio-line hover:border-studio-accent/50',
            )}
          >
            {b.logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={b.logo.url}
                alt=""
                className="h-12 w-12 shrink-0 rounded-lg bg-white/5 object-contain p-1"
              />
            ) : (
              <span
                className="h-12 w-12 shrink-0 rounded-lg"
                style={{
                  background: `linear-gradient(135deg, ${colors[0]}, ${colors[2] ?? colors[1] ?? colors[0]})`,
                }}
              />
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate font-medium text-white">{b.name}</span>
                {selected && <span className="text-studio-accent">✓</span>}
              </span>
              <span className="mt-1 flex gap-1">
                {colors.slice(0, 6).map((c, i) => (
                  <span
                    key={`${c}-${i}`}
                    className="h-3.5 w-3.5 rounded-sm border border-white/10"
                    style={{ background: c }}
                  />
                ))}
              </span>
              <Badge status={s.status} className="mt-1.5">
                {s.label}
              </Badge>
            </span>
          </button>
        );
      })}
      <a
        href={createHref}
        target="_blank"
        rel="noopener"
        data-testid="create-brand-link"
        className="flex min-h-[84px] items-center justify-center gap-2 rounded-xl border border-dashed border-studio-line p-3 text-sm text-studio-muted transition hover:border-studio-accent/60 hover:text-white"
      >
        + Create new brand
        <span className="text-xs">(opens a new tab)</span>
      </a>
    </div>
  );
}
