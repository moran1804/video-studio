'use client';

import { useEffect, useRef, useState } from 'react';
import type { AudioSettings, VoiceSettings } from '@studio/core/schemas';
import { apiBlob, apiGet, apiSend, uploadFile } from '@/lib/api';
import type { AssetDTO, ProjectBundle } from '@/lib/types';
import { formatDuration } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  ErrorNote,
  Field,
  InfoNote,
  Input,
  ProgressBar,
  SectionTitle,
  Select,
  Slider,
  Toggle,
  useAction,
} from '../ui';
import { useProject } from './ProjectContext';

interface Voice {
  id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
}

const MODES: { id: VoiceSettings['mode']; label: string; hint: string }[] = [
  {
    id: 'per-scene',
    label: 'Per scene',
    hint: 'One clip per scene, placed at each scene start – best sync.',
  },
  { id: 'full', label: 'Full script', hint: 'One continuous take of the whole script.' },
  { id: 'uploaded', label: 'My recording', hint: 'Upload your own voiceover.' },
  { id: 'none', label: 'No voiceover', hint: 'Music and captions only.' },
];

export function AudioTab() {
  const { bundle, setBundle, refresh } = useProject();
  const p = bundle.project;
  const { busy, run } = useAction();
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceSettings>(p.voiceSettings);
  const [audio, setAudio] = useState<AudioSettings>(p.audioSettings);
  const [sampleUrl, setSampleUrl] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{ kind: string; value: number } | null>(null);
  const voInput = useRef<HTMLInputElement>(null);
  const musicInput = useRef<HTMLInputElement>(null);
  const sfxInput = useRef<HTMLInputElement>(null);

  useEffect(() => setVoice(p.voiceSettings), [p.voiceSettings]);
  useEffect(() => setAudio(p.audioSettings), [p.audioSettings]);
  useEffect(() => {
    apiGet<{ voices: Voice[]; error?: string }>('/api/voices')
      .then((r) => {
        setVoices(r.voices);
        setVoiceError(r.error ?? null);
      })
      .catch((e) => setVoiceError(String(e.message ?? e)));
  }, []);
  useEffect(
    () => () => {
      if (sampleUrl) URL.revokeObjectURL(sampleUrl);
    },
    [sampleUrl],
  );

  const saveVoice = (next: VoiceSettings) => {
    setVoice(next);
    void run('voice', async () =>
      setBundle(await apiSend<ProjectBundle>(`/api/projects/${p.id}`, 'PATCH', { voiceSettings: next })),
    );
  };
  const saveAudio = (next: AudioSettings) => {
    setAudio(next);
    void run('audio', async () =>
      setBundle(await apiSend<ProjectBundle>(`/api/projects/${p.id}`, 'PATCH', { audioSettings: next })),
    );
  };

  const upload = (kind: 'voiceover' | 'music' | 'sfx', file: File) => {
    setUploadProgress({ kind, value: 0 });
    void run(
      `upload-${kind}`,
      async () =>
        setBundle(
          await uploadFile<ProjectBundle>(`/api/projects/${p.id}/assets?kind=${kind}`, file, {}, (v) =>
            setUploadProgress({ kind, value: v }),
          ),
        ),
      'Uploaded',
    ).finally(() => setUploadProgress(null));
  };

  const voJob = bundle.jobs.find(
    (j) =>
      (j.type === 'voiceover' || j.type === 'transcribe') &&
      (j.status === 'queued' || j.status === 'running'),
  );
  const voFailed = bundle.jobs.find((j) => j.type === 'voiceover' && j.status === 'failed');
  const music = bundle.audioAssets.filter((a) => a.kind === 'music');
  const sfx = bundle.audioAssets.filter((a) => a.kind === 'sfx');
  const scenesWithText = bundle.scenes.filter((s) => s.voiceoverText.trim());

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card className="p-5">
        <SectionTitle
          title="Voiceover"
          subtitle="ElevenLabs voices. Regenerating the voiceover never regenerates video."
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => saveVoice({ ...voice, mode: m.id })}
              className={`rounded-lg border p-2 text-left text-xs transition ${voice.mode === m.id ? 'border-studio-accent bg-studio-accent/15 text-white' : 'border-studio-line text-studio-muted hover:text-white'}`}
            >
              <div className="text-sm font-medium">{m.label}</div>
              <div className="mt-0.5 leading-snug">{m.hint}</div>
            </button>
          ))}
        </div>

        {voice.mode !== 'none' && voice.mode !== 'uploaded' && (
          <div className="mt-5 space-y-4">
            {voiceError && <ErrorNote>{voiceError}</ErrorNote>}
            <Field label="Voice">
              <Select
                value={voice.voiceId}
                data-testid="voice-select"
                onChange={(e) => {
                  const v = voices.find((x) => x.id === e.target.value);
                  saveVoice({ ...voice, voiceId: e.target.value, voiceName: v?.name ?? '' });
                }}
              >
                <option value="">Select a voice…</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.labels ? ` – ${Object.values(v.labels).slice(0, 3).join(', ')}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Slider
                label="Stability"
                value={voice.stability}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => setVoice({ ...voice, stability: v })}
                format={(v) => v.toFixed(2)}
              />
              <Slider
                label="Similarity"
                value={voice.similarityBoost}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => setVoice({ ...voice, similarityBoost: v })}
                format={(v) => v.toFixed(2)}
              />
              <Slider
                label="Style exaggeration"
                value={voice.style}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => setVoice({ ...voice, style: v })}
                format={(v) => v.toFixed(2)}
              />
              <Slider
                label="Speed"
                value={voice.speed}
                min={0.7}
                max={1.2}
                step={0.05}
                onChange={(v) => setVoice({ ...voice, speed: v })}
                format={(v) => `${v.toFixed(2)}×`}
              />
            </div>
            <Toggle
              label="Speaker boost"
              checked={voice.speakerBoost}
              onChange={(v) => setVoice({ ...voice, speakerBoost: v })}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => saveVoice(voice)} loading={busy === 'voice'}>
                Save voice settings
              </Button>
              <Button
                size="sm"
                disabled={!voice.voiceId}
                loading={busy === 'sample'}
                data-testid="voice-sample"
                onClick={() =>
                  run('sample', async () => {
                    const blob = await apiBlob('/api/voices/sample', {
                      voiceId: voice.voiceId,
                      settings: voice,
                    });
                    setSampleUrl(URL.createObjectURL(blob));
                  })
                }
              >
                ▶ Preview sample
              </Button>
              {sampleUrl && <audio src={sampleUrl} controls autoPlay className="h-8" />}
            </div>
            <div className="flex flex-wrap gap-2 border-t border-studio-line pt-4">
              <Button
                variant="primary"
                disabled={!voice.voiceId || !scenesWithText.length || Boolean(voJob)}
                loading={busy === 'gen-vo'}
                data-testid="generate-voiceover"
                onClick={() =>
                  run(
                    'gen-vo',
                    async () => {
                      await apiSend(`/api/projects/${p.id}`, 'PATCH', { voiceSettings: voice });
                      await apiSend(`/api/projects/${p.id}/voiceover`, 'POST', {
                        mode: voice.mode === 'full' ? 'full' : 'per-scene',
                      });
                      await refresh();
                    },
                    'Generating voiceover…',
                  )
                }
              >
                {voice.mode === 'full'
                  ? 'Generate full voiceover'
                  : `Generate voiceover for ${scenesWithText.length} scenes`}
              </Button>
            </div>
          </div>
        )}

        {voice.mode === 'uploaded' && (
          <div className="mt-5 space-y-3">
            <p className="text-sm text-studio-muted">
              Upload a recording (MP3, WAV, M4A…). It is transcribed for caption timing when OpenAI is
              configured.
            </p>
            <Button onClick={() => voInput.current?.click()} loading={busy === 'upload-voiceover'}>
              Upload voiceover
            </Button>
            <input
              ref={voInput}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) upload('voiceover', f);
              }}
            />
          </div>
        )}

        {uploadProgress && <ProgressBar className="mt-3" value={uploadProgress.value} />}
        {voJob && (
          <div className="mt-4">
            <InfoNote>
              {voJob.type === 'transcribe' ? 'Transcribing your recording…' : 'Generating voiceover…'}{' '}
              {Math.round(voJob.progress * 100)}%
            </InfoNote>
          </div>
        )}
        {voFailed && !voJob && (
          <div className="mt-4">
            <ErrorNote>Voiceover failed: {voFailed.error}</ErrorNote>
          </div>
        )}

        <div className="mt-5 space-y-2">
          {(voice.mode === 'full' || voice.mode === 'uploaded') && bundle.voiceover && (
            <AudioRow
              asset={bundle.voiceover}
              label={voice.mode === 'uploaded' ? 'Your recording' : 'Full voiceover'}
            />
          )}
          {voice.mode === 'per-scene' &&
            bundle.scenes.map((s, i) =>
              s.voiceover ? (
                <div key={s.id} className="flex flex-wrap items-center gap-2">
                  <AudioRow
                    asset={s.voiceover}
                    label={`Scene ${i + 1}`}
                    warn={
                      s.voiceover.durationSec && s.voiceover.durationSec > s.durationSec + 0.3
                        ? `longer than scene (${s.durationSec}s)`
                        : undefined
                    }
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={Boolean(voJob)}
                    onClick={() =>
                      run(
                        `re-${s.id}`,
                        async () => {
                          await apiSend(`/api/projects/${p.id}/voiceover`, 'POST', {
                            mode: 'per-scene',
                            sceneIds: [s.id],
                          });
                          await refresh();
                        },
                        'Regenerating…',
                      )
                    }
                  >
                    ↻
                  </Button>
                </div>
              ) : null,
            )}
        </div>
      </Card>

      <div className="space-y-6">
        <Card className="p-5">
          <SectionTitle
            title="Music"
            subtitle="Upload music you have a licence to use. Commercial tracks are never generated or copied."
            actions={
              <Button
                size="sm"
                onClick={() => musicInput.current?.click()}
                loading={busy === 'upload-music'}
                data-testid="upload-music"
              >
                Upload music
              </Button>
            }
          />
          <input
            ref={musicInput}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) upload('music', f);
            }}
          />
          <Field label="Music track">
            <Select
              value={audio.musicAssetId ?? ''}
              onChange={(e) => saveAudio({ ...audio, musicAssetId: e.target.value || null })}
            >
              <option value="">No music</option>
              {music.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} {m.durationSec ? `(${formatDuration(m.durationSec)})` : ''}
                </option>
              ))}
            </Select>
          </Field>
          {music.length > 0 && (
            <div className="mt-3 space-y-2">
              {music.map((m) => (
                <AudioRow
                  key={m.id}
                  asset={m}
                  label={m.name ?? 'Music'}
                  onDelete={async () =>
                    setBundle(await apiSend<ProjectBundle>(`/api/assets/${m.id}`, 'DELETE'))
                  }
                />
              ))}
            </div>
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Slider
              label="Music volume"
              value={audio.musicVolume}
              min={0}
              max={1.5}
              step={0.05}
              onChange={(v) => setAudio({ ...audio, musicVolume: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <Slider
              label="Voiceover volume"
              value={audio.voiceVolume}
              min={0}
              max={2}
              step={0.05}
              onChange={(v) => setAudio({ ...audio, voiceVolume: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <Slider
              label="Fade in"
              value={audio.musicFadeInSec}
              min={0}
              max={5}
              step={0.5}
              onChange={(v) => setAudio({ ...audio, musicFadeInSec: v })}
              format={(v) => `${v}s`}
            />
            <Slider
              label="Fade out"
              value={audio.musicFadeOutSec}
              min={0}
              max={8}
              step={0.5}
              onChange={(v) => setAudio({ ...audio, musicFadeOutSec: v })}
              format={(v) => `${v}s`}
            />
          </div>
          <div className="mt-4 space-y-3">
            <Toggle
              label="Duck music under speech"
              checked={audio.ducking}
              onChange={(v) => setAudio({ ...audio, ducking: v })}
            />
            <Toggle
              label="Loop music if shorter than the video (otherwise it ends)"
              checked={audio.musicLoop}
              onChange={(v) => setAudio({ ...audio, musicLoop: v })}
            />
            <Toggle
              label="Keep the generated clips' original audio"
              checked={audio.originalAudio}
              onChange={(v) => setAudio({ ...audio, originalAudio: v })}
            />
            {audio.originalAudio && (
              <Slider
                label="Original audio volume"
                value={audio.originalVolume}
                min={0}
                max={1.5}
                step={0.05}
                onChange={(v) => setAudio({ ...audio, originalVolume: v })}
                format={(v) => `${Math.round(v * 100)}%`}
              />
            )}
          </div>
          <div className="mt-4 flex justify-end">
            <Button
              variant="primary"
              size="sm"
              onClick={() => saveAudio(audio)}
              loading={busy === 'audio'}
              data-testid="save-audio"
            >
              Save audio mix
            </Button>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle
            title="Sound effects"
            subtitle="Place licensed sound effects on the timeline."
            actions={
              <Button size="sm" onClick={() => sfxInput.current?.click()} loading={busy === 'upload-sfx'}>
                Upload SFX
              </Button>
            }
          />
          <input
            ref={sfxInput}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) upload('sfx', f);
            }}
          />
          {sfx.length === 0 && <p className="text-sm text-studio-muted">No sound effects uploaded.</p>}
          <div className="space-y-3">
            {sfx.map((a) => {
              const cues = audio.sfx.filter((c) => c.assetId === a.id);
              return (
                <div key={a.id} className="rounded-lg border border-studio-line p-3">
                  <AudioRow
                    asset={a}
                    label={a.name ?? 'SFX'}
                    onDelete={async () =>
                      setBundle(await apiSend<ProjectBundle>(`/api/assets/${a.id}`, 'DELETE'))
                    }
                  />
                  {cues.map((c) => {
                    const idx = audio.sfx.indexOf(c);
                    return (
                      <div key={idx} className="mt-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                        <Field label="At (s)">
                          <Input
                            type="number"
                            min={0}
                            step={0.1}
                            value={c.atSec}
                            onChange={(e) =>
                              setAudio({
                                ...audio,
                                sfx: audio.sfx.map((x, i) =>
                                  i === idx ? { ...x, atSec: Number(e.target.value) } : x,
                                ),
                              })
                            }
                          />
                        </Field>
                        <Field label="Volume">
                          <Input
                            type="number"
                            min={0}
                            max={2}
                            step={0.1}
                            value={c.volume}
                            onChange={(e) =>
                              setAudio({
                                ...audio,
                                sfx: audio.sfx.map((x, i) =>
                                  i === idx ? { ...x, volume: Number(e.target.value) } : x,
                                ),
                              })
                            }
                          />
                        </Field>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setAudio({ ...audio, sfx: audio.sfx.filter((_, i) => i !== idx) })}
                        >
                          ✕
                        </Button>
                      </div>
                    );
                  })}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-2"
                    onClick={() =>
                      setAudio({ ...audio, sfx: [...audio.sfx, { assetId: a.id, atSec: 0, volume: 1 }] })
                    }
                  >
                    + Place on timeline
                  </Button>
                </div>
              );
            })}
          </div>
          {sfx.length > 0 && (
            <div className="mt-3 flex justify-end">
              <Button size="sm" variant="primary" onClick={() => saveAudio(audio)} loading={busy === 'audio'}>
                Save SFX placement
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function AudioRow({
  asset,
  label,
  warn,
  onDelete,
}: {
  asset: AssetDTO;
  label: string;
  warn?: string;
  onDelete?: () => Promise<void>;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded-lg bg-black/20 px-3 py-2">
      <span className="min-w-[90px] truncate text-xs text-zinc-300" title={label}>
        {label}
      </span>
      <audio src={asset.url} controls preload="none" className="h-8 min-w-0 flex-1" />
      {asset.durationSec ? (
        <span className="text-xs text-studio-muted">{formatDuration(asset.durationSec)}</span>
      ) : null}
      {warn && <Badge status="limited">{warn}</Badge>}
      <a href={asset.downloadUrl} className="text-xs text-violet-300">
        ⬇
      </a>
      {onDelete && (
        <ConfirmButton size="sm" variant="ghost" confirmLabel="Delete?" onConfirm={onDelete}>
          ✕
        </ConfirmButton>
      )}
    </div>
  );
}
