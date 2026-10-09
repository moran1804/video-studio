'use client';

import { useEffect, useMemo, useState } from 'react';
import { CAPTION_PRESETS, FONTS, SAFE_ZONES, type CaptionSettings } from '@studio/core/schemas';
import { apiGet, apiSend } from '@/lib/api';
import type { ProjectBundle } from '@/lib/types';
import { Button, Card, Field, Input, SectionTitle, Select, Slider, Toggle, useAction } from '../ui';
import { useProject } from './ProjectContext';

interface Cue {
  start: number;
  end: number;
  text: string;
  words: { text: string; start: number; end: number }[];
}
interface Overlay {
  start: number;
  end: number;
  text: string;
}

const RATIO: Record<string, [number, number]> = {
  '9:16': [9, 16],
  '1:1': [1, 1],
  '4:5': [4, 5],
  '16:9': [16, 9],
};

function hexToRgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function CaptionsTab() {
  const { bundle, setBundle } = useProject();
  const p = bundle.project;
  const { busy, run } = useAction();
  const [s, setS] = useState<CaptionSettings>(p.captionSettings);
  const [cues, setCues] = useState<Cue[]>([]);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const [total, setTotal] = useState(0);
  const [t, setT] = useState(0);
  const [showZones, setShowZones] = useState(true);

  useEffect(() => setS(p.captionSettings), [p.captionSettings]);
  useEffect(() => {
    apiGet<{ cues: Cue[]; overlays: Overlay[]; timeline: { totalSec: number } }>(
      `/api/projects/${p.id}/captions`,
    )
      .then((r) => {
        setCues(r.cues);
        setOverlays(r.overlays);
        setTotal(r.timeline.totalSec);
      })
      .catch(() => undefined);
  }, [p.id, p.updatedAt, p.voiceSettings.mode, bundle.voiceover?.id, s.source, s.maxWordsPerLine]);

  // Loop the preview clock across the timeline.
  useEffect(() => {
    if (!total) return;
    const started = performance.now();
    let raf = 0;
    const loop = () => {
      setT(((performance.now() - started) / 1000) % total);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [total]);

  const save = (next: CaptionSettings) =>
    run(
      'save',
      async () => {
        setBundle(await apiSend<ProjectBundle>(`/api/projects/${p.id}`, 'PATCH', { captionSettings: next }));
      },
      'Caption settings saved',
    );

  const applyPreset = (preset: 'bold-social' | 'clean' | 'boxed') =>
    setS((cur) => ({ ...cur, ...CAPTION_PRESETS[preset], preset }));
  const set = <K extends keyof CaptionSettings>(k: K, v: CaptionSettings[K]) =>
    setS((cur) => ({ ...cur, [k]: v, preset: k === 'preset' ? (v as CaptionSettings['preset']) : 'custom' }));

  const [rw, rh] = RATIO[p.aspectRatio] ?? [9, 16];
  const previewW = rw >= rh ? 560 : 300;
  const previewH = Math.round((previewW * rh) / rw);
  const scale = Math.min(previewW, previewH) / 1080;
  const zone = SAFE_ZONES[s.safeZone];
  const cue =
    cues.find((c) => t >= c.start && t < c.end) ??
    (cues.length ? null : { start: 0, end: 1, text: 'Your captions appear here', words: [] });
  const overlay = overlays.find((o) => t >= o.start && t < o.end);
  const bg = bundle.scenes.find((sc) => sc.thumbnailUrl)?.thumbnailUrl ?? null;

  const captionStyle = useMemo<React.CSSProperties>(() => {
    const fontPx = s.fontSize * scale;
    const base: React.CSSProperties = {
      fontFamily: `"${s.font}", Montserrat, Inter, sans-serif`,
      fontWeight: 800,
      fontSize: `${fontPx}px`,
      lineHeight: 1.15,
      color: s.textColor,
      textTransform: s.uppercase ? 'uppercase' : 'none',
      textAlign: 'center',
    };
    if (s.style === 'outline') {
      base.WebkitTextStroke = `${Math.max(1, s.outlineWidth * scale * 1.6)}px ${s.outlineColor}`;
      base.paintOrder = 'stroke fill';
      base.textShadow = `0 ${2 * scale}px ${4 * scale}px rgba(0,0,0,.5)`;
    } else if (s.style === 'box') {
      base.background = hexToRgba(s.boxColor, s.boxOpacity);
      base.padding = `${6 * scale * 2}px ${10 * scale * 2}px`;
      base.borderRadius = 6;
      base.boxDecorationBreak = 'clone';
    }
    return base;
  }, [s, scale]);

  const position: React.CSSProperties =
    s.position === 'top'
      ? { top: `${zone.top * 100}%` }
      : s.position === 'center'
        ? { top: '50%', transform: 'translateY(-50%)' }
        : { bottom: `${zone.bottom * 100}%` };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_auto]">
      <Card className="p-5">
        <SectionTitle
          title="Captions"
          subtitle="Generated from the voiceover timing (or the approved script). Burned into the video and exported as SRT."
          actions={
            <a href={`/api/projects/${p.id}/captions?format=srt`}>
              <Button size="sm">⬇ Download SRT</Button>
            </a>
          }
        />
        <div className="mb-4 flex flex-wrap gap-2">
          {(['bold-social', 'clean', 'boxed'] as const).map((pr) => (
            <button
              key={pr}
              type="button"
              onClick={() => applyPreset(pr)}
              className={`rounded-lg border px-3 py-2 text-sm ${s.preset === pr ? 'border-studio-accent bg-studio-accent/15 text-white' : 'border-studio-line text-studio-muted hover:text-white'}`}
            >
              {pr === 'bold-social' ? 'Bold social' : pr === 'clean' ? 'Clean' : 'Boxed'}
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Toggle label="Captions enabled" checked={s.enabled} onChange={(v) => set('enabled', v)} />
          <Toggle label="Burn into video" checked={s.burnIn} onChange={(v) => set('burnIn', v)} />
          <Toggle
            label="Word-by-word highlight"
            checked={s.wordHighlight}
            onChange={(v) => set('wordHighlight', v)}
          />
          <Toggle label="Uppercase" checked={s.uppercase} onChange={(v) => set('uppercase', v)} />
          <Toggle
            label="Show scene on-screen text"
            checked={s.showOnScreenText}
            onChange={(v) => set('showOnScreenText', v)}
          />
          <Toggle label="Show safe-zone guides (preview)" checked={showZones} onChange={setShowZones} />
          <Field label="Timing source">
            <Select
              value={s.source}
              onChange={(e) => set('source', e.target.value as CaptionSettings['source'])}
            >
              <option value="voiceover">Voiceover timing (recommended)</option>
              <option value="script">Approved script (even spacing)</option>
            </Select>
          </Field>
          <Field label="Font">
            <Select value={s.font} onChange={(e) => set('font', e.target.value as CaptionSettings['font'])}>
              {FONTS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Position">
            <Select
              value={s.position}
              onChange={(e) => set('position', e.target.value as CaptionSettings['position'])}
            >
              <option value="bottom">Bottom (above UI)</option>
              <option value="center">Centre</option>
              <option value="top">Top</option>
            </Select>
          </Field>
          <Field label="Safe zone">
            <Select
              value={s.safeZone}
              onChange={(e) => set('safeZone', e.target.value as CaptionSettings['safeZone'])}
            >
              <option value="tiktok">TikTok interface</option>
              <option value="reels">Instagram Reels interface</option>
              <option value="shorts">YouTube Shorts interface</option>
              <option value="none">None</option>
            </Select>
          </Field>
          <Field label="Style">
            <Select
              value={s.style}
              onChange={(e) => set('style', e.target.value as CaptionSettings['style'])}
            >
              <option value="outline">Outline</option>
              <option value="box">Background box</option>
              <option value="none">Plain</option>
            </Select>
          </Field>
          <Slider
            label="Font size"
            value={s.fontSize}
            min={24}
            max={160}
            step={2}
            onChange={(v) => set('fontSize', v)}
          />
          <Slider
            label="Words per caption"
            value={s.maxWordsPerLine}
            min={1}
            max={8}
            step={1}
            onChange={(v) => set('maxWordsPerLine', v)}
          />
          {s.style === 'outline' && (
            <Slider
              label="Outline width"
              value={s.outlineWidth}
              min={0}
              max={12}
              step={1}
              onChange={(v) => set('outlineWidth', v)}
            />
          )}
          {s.style === 'box' && (
            <Slider
              label="Box opacity"
              value={s.boxOpacity}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => set('boxOpacity', v)}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          )}
          <div className="grid grid-cols-3 gap-2 sm:col-span-2">
            <ColorField label="Text" value={s.textColor} onChange={(v) => set('textColor', v)} />
            <ColorField
              label="Highlight"
              value={s.highlightColor}
              onChange={(v) => set('highlightColor', v)}
            />
            {s.style === 'box' ? (
              <ColorField label="Box" value={s.boxColor} onChange={(v) => set('boxColor', v)} />
            ) : (
              <ColorField label="Outline" value={s.outlineColor} onChange={(v) => set('outlineColor', v)} />
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <Button
            variant="primary"
            onClick={() => save(s)}
            loading={busy === 'save'}
            data-testid="save-captions"
          >
            Save caption settings
          </Button>
        </div>
      </Card>

      <div className="mx-auto">
        <p className="label mb-2 text-center">Live preview</p>
        <div
          className="relative overflow-hidden rounded-2xl border border-studio-line bg-gradient-to-b from-zinc-800 to-zinc-950 shadow-2xl"
          style={{ width: previewW, height: previewH, maxWidth: '100%' }}
          data-testid="caption-preview"
        >
          {bg && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={bg} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" />
          )}
          {showZones && s.safeZone !== 'none' && (
            <>
              <div
                className="absolute inset-x-0 top-0 bg-red-500/15"
                style={{ height: `${zone.top * 100}%` }}
              />
              <div
                className="absolute inset-x-0 bottom-0 bg-red-500/15"
                style={{ height: `${zone.bottom * 100}%` }}
              />
              <div
                className="absolute bottom-0 right-0 bg-red-500/15"
                style={{
                  width: `${zone.right * 100}%`,
                  top: `${zone.top * 100}%`,
                  bottom: `${zone.bottom * 100}%`,
                }}
              />
            </>
          )}
          {overlay && s.showOnScreenText && (
            <div
              className="absolute inset-x-0 flex justify-center px-3"
              style={
                s.position === 'top'
                  ? { top: '50%', transform: 'translateY(-50%)' }
                  : { top: `${(zone.top + 0.04) * 100}%` }
              }
            >
              <span
                style={{
                  ...captionStyle,
                  WebkitTextStroke: undefined,
                  background: 'rgba(0,0,0,.6)',
                  padding: `${8 * scale * 2}px ${14 * scale * 2}px`,
                  borderRadius: 6,
                  fontSize: `${s.fontSize * scale * 1.05}px`,
                  color: '#fff',
                }}
              >
                {overlay.text}
              </span>
            </div>
          )}
          {s.enabled && cue && (
            <div
              className="absolute flex justify-center"
              style={{ ...position, left: `${zone.left * 100}%`, right: `${zone.right * 100}%` }}
            >
              <span style={captionStyle}>
                {cue.words.length
                  ? cue.words.map((w, i) => (
                      <span
                        key={i}
                        style={{
                          color:
                            s.wordHighlight && t >= w.start && t < (cue.words[i + 1]?.start ?? cue.end)
                              ? s.highlightColor
                              : s.textColor,
                        }}
                      >
                        {w.text}
                        {i < cue.words.length - 1 ? ' ' : ''}
                      </span>
                    ))
                  : cue.text}
              </span>
            </div>
          )}
          <div className="absolute bottom-1 left-2 text-[10px] text-white/60">{t.toFixed(1)}s</div>
        </div>
        <p className="mt-2 max-w-[300px] text-center text-xs text-studio-muted">
          {cues.length} caption cues{total ? ` over ${total.toFixed(1)}s` : ''}. Red areas are covered by the
          platform interface.
        </p>
      </div>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label={label} group>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} colour picker`}
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-9 w-10 cursor-pointer rounded border border-studio-line bg-transparent"
        />
        <Input
          aria-label={`${label} colour hex`}
          value={value}
          onChange={(e) =>
            /^#[0-9a-fA-F]{0,6}$/.test(e.target.value) && onChange(e.target.value.toUpperCase())
          }
          className="font-mono text-xs"
        />
      </div>
    </Field>
  );
}
