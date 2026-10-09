'use client';

import { useCallback, useEffect, useState } from 'react';
import { VIDEO_PROVIDER_LABELS, VIDEO_PROVIDERS } from '@studio/core/schemas';
import { apiGet, apiSend } from '@/lib/api';
import { formatBytes, JOB_LABELS } from '@/lib/format';
import { Badge, Button, Card, Field, InfoNote, Input, SectionTitle, Select, Spinner, useAction } from './ui';

type KeyInfo = { configured: boolean; source: 'env' | 'settings' | null; masked: string | null };
interface SettingsData {
  app: {
    name: string;
    url: string;
    authEnabled: boolean;
    mockProviders: boolean;
    maxUploadMb: number;
    dataRoot: string;
  };
  keys: Record<'openai' | 'google' | 'runway' | 'kling' | 'elevenlabs', KeyInfo>;
  defaults: { videoProvider: string; llmModel: string; voiceId: string; voiceName: string };
  models: Record<string, string | null>;
  providers: {
    id: string;
    label: string;
    configured: boolean;
    capabilities: { durations: number[]; aspectRatios: string[] };
  }[];
  worker: { ageSec: number; host: string; ffmpeg: string | null } | null;
  queues: Record<string, Record<string, number> | { error: string }>;
  storage: { projects: number; brands: number; temp: number; free?: number; total?: number };
  usage: {
    type: string;
    provider: string | null;
    count: number;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    characters: number;
  }[];
}

const SERVICES: {
  id: 'openai' | 'google' | 'runway' | 'kling' | 'elevenlabs';
  label: string;
  purpose: string;
  tests: string[];
}[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    purpose: 'Briefs, storyboards, prompt rewriting, vision analysis, transcription',
    tests: ['openai'],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    purpose: 'Gemini Omni Flash and Veo 3.1 video, Nano Banana Pro character images',
    tests: ['google', 'veo', 'image'],
  },
  { id: 'runway', label: 'Runway', purpose: 'Optional Gen-4.5 video generation', tests: ['runway'] },
  {
    id: 'kling',
    label: 'Kling',
    purpose:
      'Motion transfer – your character copies the movement of a video. API key, or ACCESS_KEY:SECRET_KEY',
    tests: ['kling'],
  },
  { id: 'elevenlabs', label: 'ElevenLabs', purpose: 'Voiceovers', tests: ['elevenlabs'] },
];

export function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [tests, setTests] = useState<
    Record<string, { ok: boolean; message: string; ms: number } | 'running'>
  >({});
  const [defaults, setDefaults] = useState<SettingsData['defaults'] | null>(null);
  const [googleModels, setGoogleModels] = useState<string[] | null>(null);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const d = await apiGet<SettingsData>('/api/settings');
    setData(d);
    setDefaults((cur) => cur ?? d.defaults);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  if (!data || !defaults) {
    return (
      <div className="flex items-center gap-2 text-studio-muted">
        <Spinner /> Loading settings…
      </div>
    );
  }

  const test = async (service: string) => {
    setTests((t) => ({ ...t, [service]: 'running' }));
    try {
      const r = await apiSend<{ ok: boolean; message: string; ms: number }>('/api/settings/test', 'POST', {
        service,
      });
      setTests((t) => ({ ...t, [service]: r }));
    } catch (err) {
      setTests((t) => ({ ...t, [service]: { ok: false, message: (err as Error).message, ms: 0 } }));
    }
  };

  const used = data.storage.projects + data.storage.brands + data.storage.temp;

  return (
    <div className="space-y-6">
      <SectionTitle title="Settings" subtitle={`${data.app.name} · ${data.app.url}`} />
      {data.app.mockProviders && (
        <InfoNote>
          Mock mode is on (MOCK_PROVIDERS=true): every AI provider is simulated, no paid API is called.
        </InfoNote>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {SERVICES.map((s) => {
          const k = data.keys[s.id];
          return (
            <Card key={s.id} className="p-5" data-testid={`service-${s.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display font-semibold text-white">{s.label}</h3>
                  <p className="text-xs text-studio-muted">{s.purpose}</p>
                </div>
                <Badge status={k.configured ? 'completed' : 'draft'}>
                  {k.configured ? `Configured (${k.source})` : 'Not configured'}
                </Badge>
              </div>
              {k.masked && <p className="mt-2 font-mono text-xs text-zinc-400">Key: {k.masked}</p>}
              {k.source !== 'env' && (
                <div className="mt-3 flex gap-2">
                  <Input
                    type="password"
                    autoComplete="off"
                    placeholder={k.configured ? 'Replace key…' : 'Paste API key'}
                    value={keyDraft[s.id] ?? ''}
                    onChange={(e) => setKeyDraft({ ...keyDraft, [s.id]: e.target.value })}
                  />
                  <Button
                    disabled={!keyDraft[s.id]}
                    loading={busy === `key-${s.id}`}
                    onClick={() =>
                      run(
                        `key-${s.id}`,
                        async () => {
                          await apiSend('/api/settings/keys', 'PUT', { service: s.id, key: keyDraft[s.id] });
                          setKeyDraft({ ...keyDraft, [s.id]: '' });
                          await load();
                        },
                        `${s.label} key saved (encrypted)`,
                      )
                    }
                  >
                    Save
                  </Button>
                  {k.source === 'settings' && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        run(`del-${s.id}`, async () => {
                          await apiSend('/api/settings/keys', 'PUT', { service: s.id, key: null });
                          await load();
                        })
                      }
                    >
                      Remove
                    </Button>
                  )}
                </div>
              )}
              {k.source === 'env' && (
                <p className="mt-2 text-xs text-studio-muted">
                  Set via environment variable – change it in your .env file.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                {s.tests.map((t) => (
                  <Button
                    key={t}
                    size="sm"
                    onClick={() => test(t)}
                    loading={tests[t] === 'running'}
                    data-testid={`test-${t}`}
                  >
                    Test {t === 'veo' ? 'Veo' : t === 'google' ? 'Omni Flash' : 'connection'}
                  </Button>
                ))}
              </div>
              {s.tests.map((t) => {
                const r = tests[t];
                if (!r || r === 'running') return null;
                return (
                  <p key={t} className={`mt-2 text-xs ${r.ok ? 'text-emerald-300' : 'text-red-300'}`}>
                    {r.ok ? '✓' : '✗'} {r.message} {r.ms ? `(${r.ms} ms)` : ''}
                  </p>
                );
              })}
            </Card>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <SectionTitle title="Defaults" />
          <div className="space-y-3">
            <Field label="Default video provider">
              <Select
                value={defaults.videoProvider}
                onChange={(e) => setDefaults({ ...defaults, videoProvider: e.target.value })}
              >
                {VIDEO_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {VIDEO_PROVIDER_LABELS[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Default language model" hint={`Environment default: ${data.models.openaiEnv}`}>
              <Input
                value={defaults.llmModel}
                onChange={(e) => setDefaults({ ...defaults, llmModel: e.target.value })}
              />
            </Field>
            <Field label="Default ElevenLabs voice id">
              <Input
                value={defaults.voiceId}
                onChange={(e) => setDefaults({ ...defaults, voiceId: e.target.value })}
              />
            </Field>
            <Button
              variant="primary"
              onClick={() =>
                run(
                  'defaults',
                  async () => {
                    await apiSend('/api/settings', 'PATCH', { defaults });
                    await load();
                  },
                  'Defaults saved',
                )
              }
              loading={busy === 'defaults'}
            >
              Save defaults
            </Button>
          </div>
        </Card>

        <Card className="p-5">
          <SectionTitle
            title="Video models"
            actions={
              <Button
                size="sm"
                onClick={() =>
                  run('models', async () => {
                    const r = await apiGet<{ google: string[]; error: string | null }>(
                      '/api/settings/models',
                    );
                    setGoogleModels(r.google);
                    if (r.error) throw new Error(r.error);
                  })
                }
                loading={busy === 'models'}
              >
                List Google models
              </Button>
            }
          />
          <table className="w-full text-sm">
            <tbody className="divide-y divide-studio-line">
              {data.providers.map((p) => (
                <tr key={p.id}>
                  <td className="py-2 text-zinc-200">{p.label}</td>
                  <td className="py-2 font-mono text-xs text-studio-muted">
                    {p.id === 'google'
                      ? (data.models.google ?? '(GOOGLE_VIDEO_MODEL not set)')
                      : p.id === 'veo'
                        ? data.models.veo
                        : p.id === 'runway'
                          ? data.models.runway
                          : 'mock-testsrc'}
                  </td>
                  <td className="py-2 text-xs text-studio-muted">{p.capabilities.durations.join('/')}s</td>
                  <td className="py-2 text-right">
                    <Badge status={p.configured ? 'completed' : 'draft'}>
                      {p.configured ? 'ready' : 'not set'}
                    </Badge>
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-2 text-zinc-200">Language / vision</td>
                <td className="py-2 font-mono text-xs text-studio-muted" colSpan={3}>
                  {data.models.openai} / {data.models.vision}
                </td>
              </tr>
              <tr>
                <td className="py-2 text-zinc-200">Transcription</td>
                <td className="py-2 font-mono text-xs text-studio-muted" colSpan={3}>
                  {data.models.transcription}
                </td>
              </tr>
              <tr>
                <td className="py-2 text-zinc-200">Voice model</td>
                <td className="py-2 font-mono text-xs text-studio-muted" colSpan={3}>
                  {data.models.elevenlabs}
                </td>
              </tr>
            </tbody>
          </table>
          {googleModels && (
            <p className="mt-3 break-words font-mono text-xs text-zinc-400">
              {googleModels.length ? googleModels.join(', ') : 'No video models returned for this key.'}
            </p>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <SectionTitle title="Worker & FFmpeg" />
          {data.worker ? (
            <div className="space-y-1 text-sm">
              <p>
                <Badge status={data.worker.ageSec < 45 ? 'completed' : 'failed'}>
                  {data.worker.ageSec < 45 ? 'online' : 'stale'}
                </Badge>{' '}
                <span className="text-studio-muted">heartbeat {data.worker.ageSec}s ago</span>
              </p>
              <p className="break-words font-mono text-xs text-zinc-400">
                {data.worker.ffmpeg ?? 'FFmpeg not found'}
              </p>
            </div>
          ) : (
            <p className="text-sm text-red-300">No worker heartbeat – check the worker container.</p>
          )}
        </Card>
        <Card className="p-5">
          <SectionTitle title="Storage" />
          <div className="space-y-1 text-sm text-zinc-300">
            <p>Projects: {formatBytes(data.storage.projects)}</p>
            <p>Brands: {formatBytes(data.storage.brands)}</p>
            <p>Temp: {formatBytes(data.storage.temp)}</p>
            {data.storage.total ? (
              <p className="pt-1 text-studio-muted">
                Dataset: {formatBytes(data.storage.free)} free of {formatBytes(data.storage.total)} (studio
                uses {formatBytes(used)})
              </p>
            ) : null}
            <p className="font-mono text-xs text-studio-muted">
              {data.app.dataRoot} · upload limit {data.app.maxUploadMb} MB
            </p>
          </div>
        </Card>
        <Card className="p-5">
          <SectionTitle title="Queue health" />
          <table className="w-full text-xs">
            <thead className="text-studio-muted">
              <tr>
                <th className="text-left font-normal">Queue</th>
                <th className="font-normal">wait</th>
                <th className="font-normal">active</th>
                <th className="font-normal">failed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.queues).map(([name, c]) => (
                <tr key={name} className="text-center">
                  <td className="py-1 text-left text-zinc-200">{name}</td>
                  {'error' in c ? (
                    <td colSpan={3} className="text-red-300">
                      {String(c.error)}
                    </td>
                  ) : (
                    <>
                      <td>{(c.waiting ?? 0) + (c.delayed ?? 0)}</td>
                      <td>{c.active ?? 0}</td>
                      <td className={c.failed ? 'text-red-300' : ''}>{c.failed ?? 0}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card className="p-5">
        <SectionTitle
          title="API usage (last 30 days)"
          subtitle="Estimated from completed jobs. Video costs use the COST_PER_SECOND_* estimates; check your provider dashboards for billing."
        />
        {data.usage.length === 0 ? (
          <p className="text-sm text-studio-muted">No completed jobs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-studio-muted">
                <tr>
                  <th className="py-1 text-left font-normal">Job</th>
                  <th className="text-left font-normal">Provider</th>
                  <th className="text-right font-normal">Count</th>
                  <th className="text-right font-normal">Tokens in/out</th>
                  <th className="text-right font-normal">Characters</th>
                  <th className="text-right font-normal">Est. cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-studio-line">
                {data.usage.map((u) => (
                  <tr key={`${u.type}-${u.provider}`}>
                    <td className="py-1.5">{JOB_LABELS[u.type] ?? u.type}</td>
                    <td className="text-studio-muted">{u.provider ?? '–'}</td>
                    <td className="text-right tabular-nums">{u.count}</td>
                    <td className="text-right tabular-nums">
                      {u.inputTokens || u.outputTokens
                        ? `${u.inputTokens.toLocaleString()} / ${u.outputTokens.toLocaleString()}`
                        : '–'}
                    </td>
                    <td className="text-right tabular-nums">
                      {u.characters ? u.characters.toLocaleString() : '–'}
                    </td>
                    <td className="text-right tabular-nums">{u.cost ? `$${u.cost.toFixed(2)}` : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
