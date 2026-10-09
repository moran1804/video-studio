import fs from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg, runProcess } from './exec';
import { validateVideo } from './probe';
import { assertFilterSafePath } from '../security/paths';
import type { Timeline } from '../timeline';
import { wrapText } from '../providers/video/mock';

export const FALLBACK_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const fontCache = new Map<string, string>();

/** Resolve a font family to a file path through fontconfig (fc-match). */
export async function resolveFontFile(family: string, bold = true): Promise<string> {
  const key = `${family}|${bold}`;
  const cached = fontCache.get(key);
  if (cached) return cached;
  let file = FALLBACK_FONT;
  if (/^[A-Za-z0-9 ]{1,40}$/.test(family)) {
    try {
      const { stdout } = await runProcess(
        'fc-match',
        ['-f', '%{file}', `${family}:weight=${bold ? 'bold' : 'regular'}`],
        {
          captureStdout: true,
          timeoutMs: 10_000,
        },
      );
      const candidate = stdout.toString('utf8').trim();
      if (candidate && /^[A-Za-z0-9/_.-]+$/.test(candidate)) file = candidate;
    } catch {
      /* fontconfig unavailable */
    }
  }
  fontCache.set(key, file);
  return file;
}

export interface CardSpec {
  title: string;
  subtitle?: string;
  backgroundColor: string; // #RRGGBB
  textColor: string; // #RRGGBB
  fontFamily: string;
  logoPath?: string;
  durationSec: number;
}

export interface RenderSceneInput {
  clipPath: string;
  durationSec: number;
}

export interface RenderPlan {
  mode: 'preview' | 'final';
  width: number;
  height: number;
  fps: number;
  timeline: Timeline;
  scenes: RenderSceneInput[];
  intro?: CardSpec;
  outro?: CardSpec;
  originalAudio: boolean;
  originalVolume: number;
  voiceovers: { path: string; startSec: number; volume: number }[];
  music?: {
    path: string;
    volume: number;
    loop: boolean;
    fadeInSec: number;
    fadeOutSec: number;
    duck: boolean;
  };
  sfx: { path: string; atSec: number; volume: number }[];
  assPath?: string;
  logo?: {
    path: string;
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    scale: number;
    opacity: number;
  };
  outPath: string;
  tempDir: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number, stage: string) => void;
}

const hexToFfmpeg = (hex: string) => `0x${(/^#([0-9a-f]{6})$/i.exec(hex)?.[1] ?? '000000').toUpperCase()}`;
const f3 = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);

function encoderArgs(mode: 'preview' | 'final', intermediate: boolean): string[] {
  if (intermediate) {
    return [
      '-c:v',
      'libx264',
      '-preset',
      mode === 'final' ? 'veryfast' : 'ultrafast',
      '-crf',
      mode === 'final' ? '16' : '24',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'pcm_s16le',
    ];
  }
  return [
    '-c:v',
    'libx264',
    '-preset',
    mode === 'final' ? 'medium' : 'veryfast',
    '-crf',
    mode === 'final' ? '19' : '28',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    mode === 'final' ? '192k' : '128k',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
  ];
}

/** Normalise one scene clip: fill-crop to the target frame, 30 fps, exact duration, stereo 48 kHz audio. */
export function buildNormalizeArgs(
  input: { clipPath: string; durationSec: number; hasAudio: boolean },
  opts: {
    width: number;
    height: number;
    fps: number;
    originalAudio: boolean;
    originalVolume: number;
    mode: 'preview' | 'final';
    out: string;
  },
): string[] {
  const D = f3(input.durationSec);
  const { width: W, height: H, fps } = opts;
  const v = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=${D},trim=duration=${D},setpts=PTS-STARTPTS[v]`;
  const a =
    opts.originalAudio && input.hasAudio
      ? `[0:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo,volume=${opts.originalVolume.toFixed(3)},apad,atrim=duration=${D},asetpts=PTS-STARTPTS[a]`
      : `[1:a]atrim=duration=${D},asetpts=PTS-STARTPTS[a]`;
  return [
    '-i',
    input.clipPath,
    '-f',
    'lavfi',
    '-t',
    D,
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-filter_complex',
    `${v};${a}`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-r',
    String(fps),
    ...encoderArgs(opts.mode, true),
    '-t',
    D,
    opts.out,
  ];
}

/** Intro / outro card rendered from brand settings. Text is passed via files, never interpolated. */
export async function renderCard(
  card: CardSpec,
  opts: {
    width: number;
    height: number;
    fps: number;
    mode: 'preview' | 'final';
    out: string;
    tempDir: string;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { width: W, height: H, fps } = opts;
  const D = f3(card.durationSec);
  const font = assertFilterSafePath(await resolveFontFile(card.fontFamily, true));
  const titleFile = assertFilterSafePath(
    path.join(opts.tempDir, `card-title-${path.basename(opts.out)}.txt`),
  );
  const subFile = assertFilterSafePath(path.join(opts.tempDir, `card-sub-${path.basename(opts.out)}.txt`));
  await fs.writeFile(titleFile, wrapText(card.title || ' ', W > H ? 28 : 16, 4));
  await fs.writeFile(subFile, wrapText(card.subtitle || ' ', W > H ? 48 : 28, 3));
  const short = Math.min(W, H);
  const titleSize = Math.round(short * 0.085);
  const subSize = Math.round(short * 0.042);
  const fadeOut = Math.max(0, card.durationSec - 0.35).toFixed(3);
  const args = [
    '-f',
    'lavfi',
    '-i',
    `color=c=${hexToFfmpeg(card.backgroundColor)}:s=${W}x${H}:r=${fps}:d=${D}`,
    '-f',
    'lavfi',
    '-t',
    D,
    '-i',
    'anullsrc=r=48000:cl=stereo',
  ];
  let graph =
    `[0:v]drawtext=fontfile=${font}:textfile=${titleFile}:fontcolor=${hexToFfmpeg(card.textColor)}:fontsize=${titleSize}:line_spacing=${Math.round(titleSize * 0.25)}:x=(w-text_w)/2:y=(h-text_h)/2,` +
    `drawtext=fontfile=${font}:textfile=${subFile}:fontcolor=${hexToFfmpeg(card.textColor)}@0.85:fontsize=${subSize}:line_spacing=${Math.round(subSize * 0.3)}:x=(w-text_w)/2:y=h*0.64[bg]`;
  if (card.logoPath) {
    args.push('-i', card.logoPath);
    const logoW = Math.round((short * 0.34) / 2) * 2;
    graph += `;[2:v]scale=${logoW}:-1,format=rgba[lg];[bg][lg]overlay=x=(main_w-overlay_w)/2:y=main_h*0.2[bg2]`;
  } else {
    graph += ';[bg]null[bg2]';
  }
  graph += `;[bg2]fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.35,format=yuv420p[v]`;
  await runFfmpeg(
    [
      ...args,
      '-filter_complex',
      graph,
      '-map',
      '[v]',
      '-map',
      '1:a',
      '-r',
      String(fps),
      ...encoderArgs(opts.mode, true),
      '-t',
      D,
      opts.out,
    ],
    { timeoutMs: 5 * 60_000, signal: opts.signal },
  );
}

export interface ComposeSegment {
  path: string;
  durationSec: number;
  /** Transition into the next segment; ignored for the last. */
  transition: string;
  transitionSec: number;
}

/**
 * Build the final filter graph: join segments (xfade / concat), burn
 * captions, overlay logo, mix voiceover / music (with ducking) / SFX and
 * normalise loudness. Returns FFmpeg input args and the graph text.
 */
export function buildComposeGraph(
  plan: Omit<RenderPlan, 'scenes' | 'intro' | 'outro' | 'tempDir'>,
  segments: ComposeSegment[],
  logoWindow?: { start: number; end: number },
) {
  const inputs: string[] = [];
  const parts: string[] = [];
  segments.forEach((s) => inputs.push('-i', s.path));
  let idx = segments.length;

  // Segment audio from intermediate files has no channel-layout metadata; pin it explicitly.
  const aNorm = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  segments.forEach((_, k) => parts.push(`[${k}:a]${aNorm}[sa${k}]`));

  // --- Video / base audio join ---
  let curV = '[0:v]';
  let curA = '[sa0]';
  let curDur = segments[0]!.durationSec;
  for (let k = 1; k < segments.length; k++) {
    const prev = segments[k - 1]!;
    const seg = segments[k]!;
    const vOut = `[vj${k}]`;
    const aOut = `[aj${k}]`;
    if (prev.transition === 'cut' || prev.transitionSec <= 0) {
      parts.push(`${curV}[${k}:v]concat=n=2:v=1:a=0,fps=${plan.fps}${vOut}`);
      parts.push(`${curA}[sa${k}]concat=n=2:v=0:a=1${aOut}`);
      curDur += seg.durationSec;
    } else {
      const td = prev.transitionSec;
      const offset = Math.max(0, curDur - td);
      parts.push(`${curV}fps=${plan.fps}[vx${k}a];[${k}:v]fps=${plan.fps}[vx${k}b]`);
      parts.push(
        `[vx${k}a][vx${k}b]xfade=transition=${prev.transition}:duration=${f3(td)}:offset=${f3(offset)}${vOut}`,
      );
      parts.push(`${curA}[sa${k}]acrossfade=d=${f3(td)}${aOut}`);
      curDur += seg.durationSec - td;
    }
    curV = vOut;
    curA = aOut;
  }
  const total = curDur;

  // --- Captions (ASS) ---
  if (plan.assPath) {
    const ass = assertFilterSafePath(plan.assPath);
    parts.push(`${curV}ass=${ass}[vcap]`);
    curV = '[vcap]';
  }

  // --- Logo overlay ---
  if (plan.logo) {
    inputs.push('-i', plan.logo.path);
    const li = idx++;
    const lw = Math.max(16, Math.round((plan.width * plan.logo.scale) / 2) * 2);
    const m = Math.round(Math.min(plan.width, plan.height) * 0.045);
    const top = Math.round(plan.height * (plan.height > plan.width ? 0.06 : 0.05));
    const x = plan.logo.position.endsWith('left') ? `${m}` : `main_w-overlay_w-${m}`;
    const y = plan.logo.position.startsWith('top')
      ? `${top}`
      : `main_h-overlay_h-${Math.round(plan.height * 0.08)}`;
    const enable = logoWindow ? `:enable='between(t,${f3(logoWindow.start)},${f3(logoWindow.end)})'` : '';
    parts.push(
      `[${li}:v]scale=${lw}:-1,format=rgba,colorchannelmixer=aa=${plan.logo.opacity.toFixed(2)}[logo]`,
    );
    parts.push(`${curV}[logo]overlay=x=${x}:y=${y}${enable}[vlogo]`);
    curV = '[vlogo]';
  }
  parts.push(`${curV}format=yuv420p[vout]`);

  // --- Audio ---
  const mixInputs: string[] = [`${curA}`];
  const voLabels: string[] = [];
  plan.voiceovers.forEach((vo, i) => {
    inputs.push('-i', vo.path);
    const vi = idx++;
    const ms = Math.max(0, Math.round(vo.startSec * 1000));
    parts.push(`[${vi}:a]${aNorm},adelay=${ms}|${ms},volume=${vo.volume.toFixed(3)}[vo${i}]`);
    voLabels.push(`[vo${i}]`);
  });
  let voForMix: string | undefined;
  let voForSc: string | undefined;
  if (voLabels.length) {
    const merged = voLabels.length > 1 ? '[vomerged]' : voLabels[0]!;
    if (voLabels.length > 1)
      parts.push(
        `${voLabels.join('')}amix=inputs=${voLabels.length}:normalize=0:dropout_transition=0[vomerged]`,
      );
    if (plan.music?.duck) {
      parts.push(`${merged}asplit=2[vomix][vosc]`);
      voForMix = '[vomix]';
      voForSc = '[vosc]';
    } else voForMix = merged;
    mixInputs.push(voForMix);
  }
  if (plan.music) {
    const mu = plan.music;
    if (mu.loop) inputs.push('-stream_loop', '-1');
    inputs.push('-i', mu.path);
    const mi = idx++;
    const fadeOutStart = Math.max(0, total - mu.fadeOutSec);
    let chain = `[${mi}:a]${aNorm},atrim=duration=${f3(total)},asetpts=PTS-STARTPTS`;
    if (mu.fadeInSec > 0) chain += `,afade=t=in:st=0:d=${f3(mu.fadeInSec)}`;
    if (mu.fadeOutSec > 0) chain += `,afade=t=out:st=${f3(fadeOutStart)}:d=${f3(mu.fadeOutSec)}`;
    chain += `,volume=${mu.volume.toFixed(3)}`;
    if (voForSc) {
      parts.push(`${chain}[music]`);
      parts.push(
        `[music]${voForSc}sidechaincompress=threshold=0.02:ratio=10:attack=15:release=400:makeup=1[musicd]`,
      );
      mixInputs.push('[musicd]');
    } else {
      parts.push(`${chain}[musicd]`);
      mixInputs.push('[musicd]');
    }
  }
  plan.sfx.forEach((s, i) => {
    inputs.push('-i', s.path);
    const si = idx++;
    const ms = Math.max(0, Math.round(s.atSec * 1000));
    parts.push(`[${si}:a]${aNorm},adelay=${ms}|${ms},volume=${s.volume.toFixed(3)}[sfx${i}]`);
    mixInputs.push(`[sfx${i}]`);
  });
  const loud = `loudnorm=I=-14:TP=-1.5:LRA=11,${aNorm}`;
  if (mixInputs.length > 1) {
    parts.push(
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0:dropout_transition=0,${loud}[aout]`,
    );
  } else {
    parts.push(`${curA}${loud}[aout]`);
  }

  return { inputs, graph: parts.join(';\n'), totalSec: total };
}

export interface RenderResult {
  durationSec: number;
  graph: string;
}

/** Full render: validate + normalise clips, cards, compose, encode. */
export async function renderVideo(plan: RenderPlan): Promise<RenderResult> {
  const { width, height, fps, mode, tempDir } = plan;
  const progress = plan.onProgress ?? (() => undefined);
  const segments: ComposeSegment[] = [];
  const steps = plan.scenes.length + (plan.intro ? 1 : 0) + (plan.outro ? 1 : 0);
  let done = 0;
  const stepDone = (stage: string) => progress(0.45 * (++done / Math.max(1, steps)), stage);

  if (plan.intro) {
    const out = path.join(tempDir, 'seg-intro.mkv');
    await renderCard(plan.intro, { width, height, fps, mode, out, tempDir, signal: plan.signal });
    segments.push({ path: out, durationSec: plan.intro.durationSec, transition: 'cut', transitionSec: 0 });
    stepDone('intro');
  }

  for (let i = 0; i < plan.scenes.length; i++) {
    const s = plan.scenes[i]!;
    const entry = plan.timeline.entries[i]!;
    let info;
    try {
      info = await validateVideo(s.clipPath);
    } catch (err) {
      throw new Error(`Scene ${i + 1}: clip is not a valid video (${(err as Error).message})`);
    }
    const out = path.join(tempDir, `seg-${String(i).padStart(3, '0')}.mkv`);
    await runFfmpeg(
      buildNormalizeArgs(
        { clipPath: s.clipPath, durationSec: s.durationSec, hasAudio: Boolean(info.audio) },
        {
          width,
          height,
          fps,
          originalAudio: plan.originalAudio,
          originalVolume: plan.originalVolume,
          mode,
          out,
        },
      ),
      { timeoutMs: 15 * 60_000, signal: plan.signal },
    );
    const isLast = i === plan.scenes.length - 1;
    segments.push({
      path: out,
      durationSec: s.durationSec,
      transition: isLast ? 'cut' : entry.transition,
      transitionSec: isLast ? 0 : entry.transitionOutSec,
    });
    stepDone(`scene ${i + 1}`);
  }

  if (plan.outro) {
    const out = path.join(tempDir, 'seg-outro.mkv');
    await renderCard(plan.outro, { width, height, fps, mode, out, tempDir, signal: plan.signal });
    segments.push({ path: out, durationSec: plan.outro.durationSec, transition: 'cut', transitionSec: 0 });
    stepDone('outro');
  }

  const logoWindow = plan.logo
    ? { start: plan.intro?.durationSec ?? 0, end: plan.timeline.totalSec - (plan.outro?.durationSec ?? 0) }
    : undefined;
  const { inputs, graph, totalSec } = buildComposeGraph(plan, segments, logoWindow);
  const graphFile = path.join(tempDir, 'compose.filtergraph');
  await fs.writeFile(graphFile, graph);
  await runFfmpeg(
    [
      ...inputs,
      '-filter_complex_script',
      graphFile,
      '-map',
      '[vout]',
      '-map',
      '[aout]',
      '-r',
      String(fps),
      ...encoderArgs(mode, false),
      '-t',
      f3(totalSec),
      '-progress',
      'pipe:1',
      '-nostats',
      plan.outPath,
    ],
    {
      timeoutMs: 60 * 60_000,
      signal: plan.signal,
      durationSec: totalSec,
      onProgress: (f) => progress(0.45 + 0.53 * f, 'encoding'),
    },
  );
  progress(0.99, 'finalising');
  return { durationSec: totalSec, graph };
}
