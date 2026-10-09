'use client';

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { apiGet, apiSend, uploadFile } from '@/lib/api';
import type { CharacterDetailDTO } from '@/lib/types';
import { Button, Card, ErrorNote, Field, Input, ProgressBar, Spinner, Textarea } from './ui';

const STEPS = [
  'Studying your character sheets…',
  'Writing an identity description…',
  'Creating a clean face close-up…',
  'Creating a full-body reference…',
];

/**
 * Upload-first character creation: drop turnaround sheets / references, then
 * the AI writes an identity description and makes clean references to approve.
 */
export function NewCharacterFlow({ onDone }: { onDone: (characterId: string) => void }) {
  const [files, setFiles] = useState<{ file: File; url: string }[]>([]);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<'pick' | 'upload' | 'build'>('pick');
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => filesRef.current.forEach((f) => URL.revokeObjectURL(f.url)), []);
  useEffect(() => {
    if (phase !== 'build') return;
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 9000);
    return () => clearInterval(t);
  }, [phase]);

  const add = (list: FileList | File[]) => {
    const picked = Array.from(list).filter((f) => f.type.startsWith('image/'));
    setFiles((cur) => [...cur, ...picked.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  };

  const build = async () => {
    setError(null);
    setPhase('upload');
    let id: string | null = null;
    try {
      id = (
        await apiSend<{ character: CharacterDetailDTO }>('/api/characters', 'POST', { name, notes, consent })
      ).character.id;
      for (const [i, f] of files.entries()) {
        await uploadFile(`/api/characters/${id}/assets`, f.file, { role: 'auto' }, (p) =>
          setProgress((i + p) / files.length),
        );
      }
      setPhase('build');
      await apiSend(`/api/characters/${id}/prepare`, 'POST', {});
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        const { character } = await apiGet<{ character: CharacterDetailDTO }>(`/api/characters/${id}`);
        if (character.job?.status === 'failed')
          throw new Error(character.job.error ?? 'Preparing the character failed.');
        if (character.status === 'review' || character.status === 'ready') break;
      }
      onDone(id);
    } catch (err) {
      // Once the character exists its page shows what failed (with a retry), so go there.
      if (id) return onDone(id);
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setPhase('pick');
    }
  };

  if (phase !== 'pick') {
    return (
      <Card
        className="grid min-h-[320px] place-items-center p-8 text-center"
        data-testid="character-building"
      >
        <div className="w-full max-w-sm space-y-4">
          <Spinner className="mx-auto h-8 w-8" />
          <p className="font-display text-lg font-semibold text-white">
            {phase === 'upload' ? 'Uploading your sheets…' : STEPS[step]}
          </p>
          {phase === 'upload' ? (
            <ProgressBar value={progress} />
          ) : (
            <p className="text-sm text-studio-muted">Usually 30–90 seconds.</p>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-5 p-5" data-testid="new-character-flow">
      <div>
        <h2 className="font-display text-xl font-bold text-white">Create a virtual character</h2>
        <p className="mt-1 text-sm text-studio-muted">
          Drop your turnaround sheets and character references. The AI writes an identity description and
          makes a clean face close-up and full-body reference – the images every video uses to keep your
          character looking the same.
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
        data-testid="character-dropzone"
      >
        <p className="text-3xl">🧍</p>
        <p className="mt-2 font-medium text-white">
          Drop turnaround sheets, face close-ups and full-body shots
        </p>
        <p className="text-xs text-studio-muted">
          or click to choose · PNG, JPG, WebP · best: front, ¾, side and back views, plus a clear face
          close-up
        </p>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        data-testid="character-files-input"
        onChange={(e) => {
          if (e.target.files?.length) add(e.target.files);
          e.target.value = '';
        }}
      />

      {files.length > 0 && (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6" data-testid="character-picked">
          {files.map((f, i) => (
            <div key={f.url} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={f.url}
                alt=""
                className="aspect-square w-full rounded-xl bg-black/30 object-contain"
              />
              <button
                type="button"
                aria-label={`Remove ${f.file.name}`}
                onClick={() => {
                  URL.revokeObjectURL(f.url);
                  setFiles((cur) => cur.filter((_, j) => j !== i));
                }}
                className="absolute right-1 top-1 rounded-full bg-black/70 px-1.5 text-xs text-white"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Character name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Maya"
            data-testid="character-name"
            maxLength={120}
          />
        </Field>
        <Field label="Notes (optional)" hint="Personality, typical outfit or setting – helps the AI.">
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Fitness creator, always in her olive bomber jacket"
          />
        </Field>
      </div>

      <label className="flex items-start gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-violet-500"
          data-testid="character-consent"
        />
        <span>
          This is a fictional adult character, or I have permission from the person shown. I won&apos;t use it
          to impersonate a real person.
        </span>
      </label>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex justify-end">
        <Button
          variant="primary"
          onClick={() => void build()}
          disabled={!files.length || !name.trim() || !consent}
          data-testid="build-character"
        >
          ✨ Create character
        </Button>
      </div>
    </Card>
  );
}
