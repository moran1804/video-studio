'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { apiGet, apiSend, uploadFile } from '@/lib/api';
import type { BrandDetailDTO, BrandDTO } from '@/lib/types';
import { Button, Card, ErrorNote, Field, Input, ProgressBar, Spinner, Textarea } from './ui';

const PLACEHOLDER = 'New brand';
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf,.txt,.md';
const STEPS = [
  'Reading your logos and posters…',
  'Picking out your colours…',
  'Matching fonts and style…',
  'Writing your style guide…',
];

interface Picked {
  file: File;
  url: string | null;
}

/**
 * Upload-first brand creation: drop logos, posters, flyers or guidelines and the
 * AI builds the brand profile (name, palette, fonts, style, tone, CTA, handles).
 */
export function NewBrandFlow({
  onDone,
  onManual,
}: {
  onDone: (brandId: string) => void;
  onManual: () => void;
}) {
  const [files, setFiles] = useState<Picked[]>([]);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [phase, setPhase] = useState<'pick' | 'upload' | 'build'>('pick');
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => filesRef.current.forEach((f) => f.url && URL.revokeObjectURL(f.url)), []);

  // Rotate the progress messages while the AI works.
  useEffect(() => {
    if (phase !== 'build') return;
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 6000);
    return () => clearInterval(t);
  }, [phase]);

  const add = (list: FileList | File[]) => {
    const picked = Array.from(list).filter(
      (f) => /^(image\/|application\/pdf|text\/)/.test(f.type) || /\.(md|txt|pdf)$/i.test(f.name),
    );
    setFiles((cur) => [
      ...cur,
      ...picked.map((file) => ({
        file,
        url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      })),
    ]);
  };

  const build = async () => {
    setError(null);
    setPhase('upload');
    let brandId: string | null = null;
    try {
      brandId = (
        await apiSend<{ brand: BrandDTO }>('/api/brands', 'POST', { name: name.trim() || PLACEHOLDER })
      ).brand.id;
      for (const [i, f] of files.entries()) {
        await uploadFile(
          `/api/brands/${brandId}/assets`,
          f.file,
          { role: 'auto', label: f.file.name.replace(/\.[^.]+$/, '') },
          (p) => setProgress((i + p) / files.length),
        );
      }
      setPhase('build');
      await apiSend(`/api/brands/${brandId}/design-system/generate`, 'POST', { mode: 'create', notes });
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const { brand } = await apiGet<{ brand: BrandDetailDTO }>(`/api/brands/${brandId}`);
        if (brand.job?.status === 'failed')
          throw new Error(brand.job.error ?? 'The AI could not build the brand.');
        if (brand.designStatus === 'draft' || brand.designStatus === 'approved') break;
      }
      onDone(brandId);
    } catch (err) {
      // Once the brand exists its page shows what failed (with Regenerate), so go there.
      if (brandId) return onDone(brandId);
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setPhase('pick');
    }
  };

  if (phase !== 'pick') {
    return (
      <Card className="grid min-h-[320px] place-items-center p-8 text-center" data-testid="brand-building">
        <div className="w-full max-w-sm space-y-4">
          <Spinner className="mx-auto h-8 w-8" />
          <p className="font-display text-lg font-semibold text-white">
            {phase === 'upload' ? 'Uploading your files…' : STEPS[step]}
          </p>
          {phase === 'upload' ? (
            <ProgressBar value={progress} />
          ) : (
            <p className="text-sm text-studio-muted">This usually takes 20–60 seconds.</p>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-5 p-5" data-testid="new-brand-flow">
      <div>
        <h2 className="font-display text-xl font-bold text-white">Build a brand from your files</h2>
        <p className="mt-1 text-sm text-studio-muted">
          Drop in logos, posters, flyers, product shots or a brand-guidelines PDF. The AI works out the name,
          colours, fonts, visual style and tone, and you can tweak everything afterwards.
        </p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) add(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        className={clsx(
          'cursor-pointer rounded-2xl border-2 border-dashed px-6 py-10 text-center transition',
          dragOver
            ? 'border-studio-accent bg-studio-accent/10'
            : 'border-studio-line hover:border-studio-accent/60',
        )}
        data-testid="brand-dropzone"
      >
        <p className="text-3xl">⬆</p>
        <p className="mt-2 font-medium text-white">Drop logos, posters and brand files here</p>
        <p className="text-xs text-studio-muted">or click to choose · PNG, JPG, WebP, GIF, PDF</p>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        data-testid="brand-files-input"
        onChange={(e) => {
          if (e.target.files?.length) add(e.target.files);
          e.target.value = '';
        }}
      />

      {files.length > 0 && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5" data-testid="brand-picked">
          {files.map((f, i) => (
            <div key={`${f.file.name}-${i}`} className="group relative">
              <div className="grid aspect-square place-items-center overflow-hidden rounded-xl bg-[repeating-conic-gradient(#1f1f2a_0%_25%,#15151d_0%_50%)] bg-[length:14px_14px]">
                {f.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={f.url} alt="" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-2xl">📄</span>
                )}
              </div>
              <p className="mt-1 truncate text-[11px] text-studio-muted">{f.file.name}</p>
              <button
                type="button"
                aria-label={`Remove ${f.file.name}`}
                onClick={() => {
                  if (f.url) URL.revokeObjectURL(f.url);
                  setFiles((cur) => cur.filter((_, j) => j !== i));
                }}
                className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 text-xs text-white opacity-80 hover:opacity-100"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Brand name (optional)" hint="Leave blank and the AI will read it from your logo.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="new-brand-name"
            placeholder="e.g. Rooftop Sessions"
          />
        </Field>
        <Field label="Anything else we should know? (optional)">
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Student nightlife events in Leeds, playful and loud"
          />
        </Field>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onManual}
          className="text-xs text-studio-muted underline-offset-2 hover:text-white hover:underline"
          data-testid="manual-brand"
        >
          or set up a brand manually
        </button>
        <Button
          variant="primary"
          onClick={() => void build()}
          disabled={files.length === 0}
          data-testid="build-brand"
        >
          ✨ Build my brand
        </Button>
      </div>
    </Card>
  );
}
