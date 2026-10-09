'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BRIEF_FIELDS, type Brief, type ProjectDetails } from '@studio/core/schemas';
import { apiSend } from '@/lib/api';
import type { ProjectBundle } from '@/lib/types';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  InfoNote,
  Input,
  SectionTitle,
  Spinner,
  Textarea,
  useAction,
} from '../ui';
import { useProject } from './ProjectContext';

const DETAIL_FIELDS: { key: keyof ProjectDetails; label: string; long?: boolean }[] = [
  { key: 'objective', label: 'Video objective', long: true },
  { key: 'audience', label: 'Target audience', long: true },
  { key: 'tone', label: 'Tone & visual style', long: true },
  { key: 'mainMessage', label: 'Main message', long: true },
  { key: 'callToAction', label: 'Call to action' },
  { key: 'eventDetails', label: 'Event details', long: true },
  { key: 'brandInfo', label: 'Brand information', long: true },
  { key: 'additionalContext', label: 'Additional context', long: true },
  { key: 'voiceoverPreference', label: 'Voiceover preference' },
  { key: 'musicPreference', label: 'Music preference' },
];

const EMPTY_BRIEF: Brief = {
  concept: '',
  openingHook: '',
  narrativeStructure: '',
  visualDirection: '',
  colourAndLighting: '',
  editingPace: '',
  suggestedVoiceover: '',
  captionStyle: '',
  musicDirection: '',
  closingCta: '',
};

export function BriefTab() {
  const { bundle, setBundle, refresh } = useProject();
  const p = bundle.project;
  const { busy, run } = useAction();
  const [brief, setBrief] = useState<Brief>(p.brief ?? EMPTY_BRIEF);
  const [dirty, setDirty] = useState(false);
  const [editDetails, setEditDetails] = useState(false);
  const [details, setDetails] = useState(p.details);
  const [name, setName] = useState(p.name);
  const [duration, setDuration] = useState(p.durationSec);

  useEffect(() => {
    if (!dirty) setBrief(p.brief ?? EMPTY_BRIEF);
  }, [p.brief, dirty]);

  const briefJob = bundle.jobs.find((j) => j.type === 'brief');
  const generating = p.briefStatus === 'generating';
  const failedJob = briefJob?.status === 'failed' ? briefJob : null;

  const generate = () =>
    run(
      'generate',
      async () => {
        await apiSend(`/api/projects/${p.id}/brief/generate`, 'POST');
        setDirty(false);
        await refresh();
      },
      'Generating creative brief…',
    );

  const save = () =>
    run(
      'save',
      async () => {
        setBundle(await apiSend<ProjectBundle>(`/api/projects/${p.id}/brief`, 'PATCH', { brief }));
        setDirty(false);
      },
      'Brief saved',
    );

  const approve = () =>
    run(
      'approve',
      async () => {
        if (dirty) await apiSend(`/api/projects/${p.id}/brief`, 'PATCH', { brief });
        setBundle(await apiSend<ProjectBundle>(`/api/projects/${p.id}/brief/approve`, 'POST'));
        setDirty(false);
      },
      'Brief approved – you can now generate the storyboard',
    );

  const saveDetails = () =>
    run(
      'details',
      async () => {
        setBundle(
          await apiSend<ProjectBundle>(`/api/projects/${p.id}`, 'PATCH', {
            name,
            durationSec: Number(duration),
            details,
          }),
        );
        setEditDetails(false);
      },
      'Project details saved',
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Card className="p-5">
        <SectionTitle
          title="Creative brief"
          subtitle="Generated from your project details and Reference Board. Edit anything, then approve it before generating."
          actions={
            <>
              <Badge
                status={
                  p.briefStatus === 'approved'
                    ? 'approved'
                    : p.briefStatus === 'generating'
                      ? 'running'
                      : 'draft'
                }
              >
                {p.briefStatus === 'none' ? 'Not generated' : p.briefStatus}
              </Badge>
              <Button
                onClick={generate}
                loading={busy === 'generate'}
                disabled={generating}
                data-testid="generate-brief"
              >
                {p.brief ? 'Regenerate' : 'Generate brief'}
              </Button>
            </>
          }
        />
        {generating && (
          <InfoNote>
            <span className="flex items-center gap-2">
              <Spinner /> Writing the creative brief… this usually takes 10–40 seconds.
            </span>
          </InfoNote>
        )}
        {failedJob && !generating && <ErrorNote>Brief generation failed: {failedJob.error}</ErrorNote>}
        {bundle.references.length === 0 && !p.brief && (
          <p className="mb-4 text-sm text-studio-muted">
            Tip: add reference images or videos on the{' '}
            <Link href={`/projects/${p.id}/references`} className="text-violet-300 underline">
              Reference Board
            </Link>{' '}
            first for a more tailored brief.
          </p>
        )}
        <div className="mt-4 grid gap-4 md:grid-cols-2" data-testid="brief-fields">
          {BRIEF_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              className={f.key === 'concept' || f.key === 'suggestedVoiceover' ? 'md:col-span-2' : ''}
            >
              <Textarea
                name={f.key}
                rows={f.key === 'concept' || f.key === 'suggestedVoiceover' ? 4 : 3}
                value={brief[f.key]}
                onChange={(e) => {
                  setBrief((b) => ({ ...b, [f.key]: e.target.value }));
                  setDirty(true);
                }}
                disabled={generating}
              />
            </Field>
          ))}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          {dirty && <span className="text-xs text-amber-300">Unsaved changes</span>}
          <Button onClick={save} disabled={!dirty} loading={busy === 'save'}>
            Save changes
          </Button>
          <Button
            variant="primary"
            onClick={approve}
            loading={busy === 'approve'}
            disabled={generating || !Object.values(brief).some(Boolean)}
            data-testid="approve-brief"
          >
            {p.briefStatus === 'approved' && !dirty ? 'Approved ✓' : 'Approve brief'}
          </Button>
          {p.briefStatus === 'approved' && !dirty && (
            <Link href={`/projects/${p.id}/storyboard`}>
              <Button variant="secondary">Storyboard →</Button>
            </Link>
          )}
        </div>
      </Card>

      <Card className="h-fit p-5">
        <SectionTitle
          title="Project details"
          actions={
            <Button size="sm" variant="ghost" onClick={() => setEditDetails((v) => !v)}>
              {editDetails ? 'Close' : 'Edit'}
            </Button>
          }
        />
        {editDetails ? (
          <div className="space-y-3">
            <Field label="Project name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Duration (s)">
              <Input
                type="number"
                min={5}
                max={180}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </Field>
            {DETAIL_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                {f.long ? (
                  <Textarea
                    rows={2}
                    value={details[f.key]}
                    onChange={(e) => setDetails((d) => ({ ...d, [f.key]: e.target.value }))}
                  />
                ) : (
                  <Input
                    value={details[f.key]}
                    onChange={(e) => setDetails((d) => ({ ...d, [f.key]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
            <Button variant="primary" className="w-full" onClick={saveDetails} loading={busy === 'details'}>
              Save details
            </Button>
          </div>
        ) : (
          <dl className="space-y-3 text-sm">
            {DETAIL_FIELDS.filter((f) => p.details[f.key]).map((f) => (
              <div key={f.key}>
                <dt className="label">{f.label}</dt>
                <dd className="whitespace-pre-wrap text-zinc-200">{p.details[f.key]}</dd>
              </div>
            ))}
            {!DETAIL_FIELDS.some((f) => p.details[f.key]) && (
              <p className="text-studio-muted">No details yet – add some for a better brief.</p>
            )}
          </dl>
        )}
      </Card>
    </div>
  );
}
