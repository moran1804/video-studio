'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { PLATFORM_LABELS } from '@/lib/format';
import { Badge } from '../ui';
import { useProject } from './ProjectContext';

const TABS = [
  { seg: '', label: 'Brief' },
  { seg: 'references', label: 'Reference board' },
  { seg: 'storyboard', label: 'Storyboard' },
  { seg: 'audio', label: 'Voice & audio' },
  { seg: 'captions', label: 'Captions' },
  { seg: 'brand', label: 'Branding' },
  { seg: 'export', label: 'Export' },
];

export function ProjectHeader() {
  const { bundle } = useProject();
  const p = bundle.project;
  const pathname = usePathname();
  const base = `/projects/${p.id}`;
  const current = pathname.replace(base, '').replace(/^\//, '').split('/')[0] ?? '';
  const active = bundle.jobs.filter((j) => j.status === 'queued' || j.status === 'running');

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href="/projects" className="text-xs text-studio-muted hover:text-white">
            ← All projects
          </Link>
          <h1
            className="mt-1 truncate font-display text-2xl font-bold text-white"
            data-testid="project-title"
          >
            {p.name}
          </h1>
          <p className="text-xs text-studio-muted">
            {PLATFORM_LABELS[p.platform] ?? p.platform} · {p.aspectRatio} · {p.durationSec}s target
          </p>
        </div>
        <div className="flex items-center gap-2">
          {active.length > 0 && (
            <Badge status="running">
              {active.length} job{active.length > 1 ? 's' : ''} running
            </Badge>
          )}
          <Badge status={p.status.key}>{p.status.label}</Badge>
        </div>
      </div>
      <nav className="-mx-4 mt-4 flex gap-1 overflow-x-auto border-b border-studio-line px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => (
          <Link
            key={t.seg}
            href={t.seg ? `${base}/${t.seg}` : base}
            data-testid={`tab-${t.seg || 'brief'}`}
            className={clsx(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition',
              current === t.seg
                ? 'border-studio-accent text-white'
                : 'border-transparent text-studio-muted hover:text-white',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
