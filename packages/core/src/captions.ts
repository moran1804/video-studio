import { SAFE_ZONES, type CaptionSettings } from './schemas';
import type { Timeline } from './timeline';
import type { TranscriptWord } from './providers/llm/openai';

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
  words: CaptionWord[];
}

export interface OverlayCue {
  start: number;
  end: number;
  text: string;
}

export interface CaptionSceneInput {
  id: string;
  voiceoverText: string;
  onScreenText: string;
  /** Word timings relative to the start of this scene's voiceover clip. */
  words?: TranscriptWord[];
}

export interface CaptionBuildInput {
  timeline: Timeline;
  scenes: CaptionSceneInput[];
  /** Global voiceover word timings (full / uploaded voiceover), relative to the voiceover start. */
  globalWords?: TranscriptWord[];
  mode: 'none' | 'full' | 'per-scene' | 'uploaded';
  source: CaptionSettings['source'];
  maxWordsPerLine: number;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Spread words evenly across a time window (script fallback). */
export function distributeWords(text: string, start: number, duration: number): CaptionWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length || duration <= 0) return [];
  const pad = Math.min(0.2, duration * 0.05);
  const usable = Math.max(0.1, duration - pad * 2);
  const weights = tokens.map((t) => 1 + Math.min(10, t.length) * 0.15);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = start + pad;
  return tokens.map((tok, i) => {
    const len = (weights[i]! / total) * usable;
    const w = { text: tok, start: round(t), end: round(t + len) };
    t += len;
    return w;
  });
}

/** Group words into short caption cues. */
export function chunkWords(words: CaptionWord[], maxWords: number): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let current: CaptionWord[] = [];
  const flush = () => {
    if (!current.length) return;
    cues.push({
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      text: current.map((w) => w.text).join(' '),
      words: current,
    });
    current = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = current[current.length - 1];
    if (prev && (w.start - prev.end > 0.6 || current.length >= maxWords)) flush();
    current.push(w);
    if (/[.!?,;:]$/.test(w.text)) flush();
  }
  flush();
  // Keep each cue on screen for a readable minimum, without overlapping the next.
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    const nextStart = cues[i + 1]?.start ?? Infinity;
    cue.end = round(Math.min(Math.max(cue.end, cue.start + 0.5), nextStart));
  }
  return cues;
}

/** Build caption cues for the whole video from voiceover timings or the script. */
export function buildCaptionCues(input: CaptionBuildInput): CaptionCue[] {
  const { timeline, scenes } = input;
  const useTimings = input.source === 'voiceover';
  const words: CaptionWord[] = [];

  if (useTimings && (input.mode === 'full' || input.mode === 'uploaded') && input.globalWords?.length) {
    const offset = timeline.entries[0]?.start ?? timeline.introSec;
    for (const w of input.globalWords)
      words.push({ text: w.word, start: round(w.start + offset), end: round(w.end + offset) });
  } else {
    scenes.forEach((scene, i) => {
      const entry = timeline.entries[i];
      if (!entry) return;
      if (useTimings && input.mode === 'per-scene' && scene.words?.length) {
        for (const w of scene.words)
          words.push({ text: w.word, start: round(w.start + entry.start), end: round(w.end + entry.start) });
      } else if (scene.voiceoverText.trim()) {
        words.push(
          ...distributeWords(
            scene.voiceoverText,
            entry.start,
            entry.durationSec - entry.transitionOutSec / 2,
          ),
        );
      }
    });
  }
  words.sort((a, b) => a.start - b.start);
  return chunkWords(words, input.maxWordsPerLine);
}

export function buildOverlayCues(timeline: Timeline, scenes: CaptionSceneInput[]): OverlayCue[] {
  const out: OverlayCue[] = [];
  scenes.forEach((s, i) => {
    const e = timeline.entries[i];
    if (!e || !s.onScreenText.trim()) return;
    out.push({
      start: round(e.start + 0.15),
      end: round(e.start + e.durationSec - Math.max(0.15, e.transitionOutSec)),
      text: s.onScreenText.trim(),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}

export function toSrt(cues: CaptionCue[]): string {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

// ---------------------------------------------------------------------------
// ASS (burned-in via libass)
// ---------------------------------------------------------------------------

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const r = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(2, '0')}`;
}

/** #RRGGBB + opacity → &HAABBGGRR */
export function assColor(hex: string, opacity = 1): string {
  const h = /^#([0-9a-f]{6})$/i.exec(hex)?.[1] ?? 'FFFFFF';
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  const a = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** Remove characters that have meaning inside ASS dialogue text. */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '/')
    .replace(/[{}]/g, (c) => (c === '{' ? '(' : ')'))
    .replace(/\r?\n/g, ' ');
}

export interface AssOptions {
  width: number;
  height: number;
  settings: CaptionSettings;
  headlineFont?: string;
  headlineColor?: string;
  watermarkText?: string;
  watermarkOpacity?: number;
  totalSec?: number;
}

export function toAss(cues: CaptionCue[], overlays: OverlayCue[], opts: AssOptions): string {
  const s = opts.settings;
  const { width: W, height: H } = opts;
  const scale = Math.min(W, H) / 1080;
  const zone = SAFE_ZONES[s.safeZone];
  const fontSize = Math.round(s.fontSize * scale);
  const alignment = s.position === 'top' ? 8 : s.position === 'center' ? 5 : 2;
  const marginV =
    s.position === 'center' ? 0 : Math.round((s.position === 'top' ? zone.top : zone.bottom) * H);
  const marginL = Math.round(zone.left * W);
  const marginR = Math.round(zone.right * W);
  const boxed = s.style === 'box';
  const outline =
    s.style === 'none' ? 0 : boxed ? Math.round(14 * scale) : Math.round(s.outlineWidth * scale);
  const outlineColour = boxed ? assColor(s.boxColor, s.boxOpacity) : assColor(s.outlineColor);
  const primary = assColor(s.textColor);
  const highlight = assColor(s.highlightColor);
  const shadow = s.style === 'outline' ? Math.round(2 * scale) : 0;

  const headlineSize = Math.round(fontSize * 1.05);
  const headlineAlign = s.position === 'top' ? 5 : 8;
  const headlineMarginV = headlineAlign === 8 ? Math.round((zone.top + 0.04) * H) : 0;

  const styles = [
    `Style: Caption,${s.font},${fontSize},${primary},${primary},${outlineColour},&H64000000,-1,0,0,0,100,100,0,0,${boxed ? 3 : 1},${outline},${shadow},${alignment},${marginL},${marginR},${marginV},1`,
    `Style: Headline,${opts.headlineFont ?? s.font},${headlineSize},${assColor('#FFFFFF')},${assColor('#FFFFFF')},${assColor(opts.headlineColor ?? '#000000', 0.75)},&H64000000,-1,0,0,0,100,100,0,0,3,${Math.round(18 * scale)},0,${headlineAlign},${marginL},${marginR},${headlineMarginV},1`,
    `Style: Watermark,${s.font},${Math.round(34 * scale)},${assColor('#FFFFFF', opts.watermarkOpacity ?? 0.35)},${assColor('#FFFFFF')},${assColor('#000000', (opts.watermarkOpacity ?? 0.35) * 0.6)},&H00000000,-1,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(2 * scale))},0,3,${marginL},${marginR},${Math.round(zone.bottom * H * 0.5)},1`,
  ];

  const tx = (t: string) => escapeAssText(s.uppercase ? t.toUpperCase() : t);
  const events: string[] = [];

  for (const o of overlays) {
    events.push(
      `Dialogue: 1,${assTime(o.start)},${assTime(o.end)},Headline,,0,0,0,,{\\fad(150,150)}${tx(o.text)}`,
    );
  }

  if (s.enabled && s.burnIn) {
    for (const cue of cues) {
      if (s.wordHighlight && cue.words.length > 1) {
        cue.words.forEach((w, i) => {
          const start = i === 0 ? cue.start : w.start;
          const end = i === cue.words.length - 1 ? cue.end : cue.words[i + 1]!.start;
          if (end <= start) return;
          const text = cue.words
            .map((x, j) => (j === i ? `{\\c${highlight}}${tx(x.text)}{\\c${primary}}` : tx(x.text)))
            .join(' ');
          events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`);
        });
      } else {
        events.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Caption,,0,0,0,,${tx(cue.text)}`);
      }
    }
  }

  if (opts.watermarkText && opts.totalSec) {
    events.push(
      `Dialogue: 2,${assTime(0)},${assTime(opts.totalSec)},Watermark,,0,0,0,,${escapeAssText(opts.watermarkText)}`,
    );
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
