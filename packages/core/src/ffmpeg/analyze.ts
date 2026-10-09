import fs from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg } from './exec';
import type { ReferenceAnalysis } from '../schemas';

/** Detect hard cuts with FFmpeg's scene score. Returns cut timestamps (seconds). */
export async function detectCuts(
  file: string,
  opts: { threshold?: number; maxSec?: number } = {},
): Promise<number[]> {
  const threshold = opts.threshold ?? 0.3;
  const { stderr } = await runFfmpeg(
    [
      '-t',
      String(opts.maxSec ?? 180),
      '-i',
      file,
      '-an',
      '-sn',
      '-vf',
      `scale=320:-2,select='gt(scene,${threshold})',showinfo`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 10 * 60_000 },
  );
  return parseShowinfoTimes(stderr);
}

export function parseShowinfoTimes(stderr: string): number[] {
  const times: number[] = [];
  const re = /pts_time:([0-9.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && (times.length === 0 || t - times[times.length - 1]! > 0.2)) times.push(t);
  }
  return times;
}

export function editingStats(
  cutTimes: number[],
  durationSec: number,
): NonNullable<ReferenceAnalysis['editing']> {
  const shotCount = cutTimes.length + 1;
  const avg = durationSec > 0 ? durationSec / shotCount : 0;
  const pace = avg < 1.2 ? 'very fast' : avg < 2.5 ? 'fast' : avg < 5 ? 'moderate' : 'slow';
  return {
    shotCount,
    averageShotLengthSec: Math.round(avg * 100) / 100,
    pace,
    cutTimes: cutTimes.slice(0, 200).map((t) => Math.round(t * 100) / 100),
  };
}

/** Choose representative timestamps: shot midpoints + even samples, capped. */
export function frameTimestamps(cutTimes: number[], durationSec: number, max = 8): number[] {
  const bounds = [0, ...cutTimes, durationSec];
  const mids: number[] = [];
  for (let i = 0; i < bounds.length - 1; i++) mids.push((bounds[i]! + bounds[i + 1]!) / 2);
  let picks = mids;
  if (mids.length > max) {
    picks = Array.from({ length: max }, (_, i) => mids[Math.floor((i * mids.length) / max)]!);
  } else if (mids.length < Math.min(max, 6) && durationSec > 0) {
    const extra = Array.from(
      { length: Math.min(max, 6) },
      (_, i) => ((i + 0.5) * durationSec) / Math.min(max, 6),
    );
    picks = [...new Set([...mids, ...extra].map((t) => Math.round(t * 10) / 10))]
      .sort((a, b) => a - b)
      .slice(0, max);
  }
  return picks.filter((t) => t >= 0 && t < Math.max(0.1, durationSec - 0.05));
}

/** Extract JPEG frames (max 512px on the long side) at given timestamps. */
export async function extractFrames(file: string, times: number[], outDir: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const target = path.join(outDir, `frame-${String(i).padStart(2, '0')}.jpg`);
    try {
      await runFfmpeg(
        [
          '-ss',
          times[i]!.toFixed(2),
          '-i',
          file,
          '-frames:v',
          '1',
          '-vf',
          "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'",
          '-q:v',
          '4',
          target,
        ],
        { timeoutMs: 60_000 },
      );
      await fs.access(target);
      out.push(target);
    } catch {
      /* skip unreadable timestamp */
    }
  }
  return out;
}

async function assertWritten(target: string, what: string): Promise<void> {
  const st = await fs.stat(target).catch(() => null);
  if (!st || st.size === 0)
    throw new Error(`Could not decode ${what} – the file may be corrupt or in an unsupported format.`);
}

/** Single frame thumbnail (used for scenes, renders and image references). */
export async function makeThumbnail(file: string, target: string, atSec = 0.5, maxSize = 480): Promise<void> {
  const seek = atSec > 0 ? ['-ss', atSec.toFixed(2)] : [];
  try {
    await runFfmpeg(
      [
        ...seek,
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `scale='if(gt(iw,ih),${maxSize},-2)':'if(gt(iw,ih),-2,${maxSize})'`,
        '-q:v',
        '5',
        target,
      ],
      { timeoutMs: 60_000 },
    );
  } catch (err) {
    throw new Error(`Could not decode the image or video frame (${(err as Error).message.slice(0, 200)})`);
  }
  await assertWritten(target, 'the image or video frame');
}

/** Dominant colours via a tiny downscale per frame and simple quantisation. */
export async function extractPalette(files: string[], count = 6): Promise<string[]> {
  const buckets = new Map<string, number>();
  for (const f of files) {
    try {
      const { stdout } = await runFfmpeg(
        ['-i', f, '-vf', 'scale=12:12:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        {
          captureStdout: true,
          timeoutMs: 30_000,
        },
      );
      for (let i = 0; i + 2 < stdout.length; i += 3) {
        const q = (v: number) => Math.min(255, Math.round(v / 32) * 32);
        const key = [q(stdout[i]!), q(stdout[i + 1]!), q(stdout[i + 2]!)]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('');
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
    } catch {
      /* ignore */
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([k]) => `#${k.toUpperCase()}`);
}

/** Integrated loudness / LRA via ebur128, mapped to an energy label. */
export async function analyzeLoudness(file: string): Promise<NonNullable<ReferenceAnalysis['audio']>> {
  const { stderr } = await runFfmpeg(
    ['-t', '180', '-i', file, '-vn', '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'],
    {
      timeoutMs: 10 * 60_000,
    },
  );
  return parseEbur128(stderr);
}

export function parseEbur128(stderr: string): NonNullable<ReferenceAnalysis['audio']> {
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const I = Number(/I:\s+(-?[0-9.]+) LUFS/.exec(summary)?.[1]);
  const LRA = Number(/LRA:\s+([0-9.]+) LU/.exec(summary)?.[1]);
  const integratedLufs = Number.isFinite(I) ? I : undefined;
  const loudnessRange = Number.isFinite(LRA) ? LRA : undefined;
  let energy: 'low' | 'medium' | 'high' | undefined;
  if (integratedLufs !== undefined)
    energy = integratedLufs > -12 ? 'high' : integratedLufs > -20 ? 'medium' : 'low';
  return { integratedLufs, loudnessRange, energy };
}

/** Extract mono 16 kHz MP3 audio suitable for transcription (max 10 minutes). */
export async function extractSpeechAudio(file: string, target: string): Promise<void> {
  await runFfmpeg(
    ['-t', '600', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', target],
    {
      timeoutMs: 10 * 60_000,
    },
  );
}

/** Resize an image/frame for provider image-conditioning (JPEG, max 1280px). */
export async function prepareReferenceImage(file: string, target: string): Promise<void> {
  await runFfmpeg(
    [
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
      '-q:v',
      '3',
      target,
    ],
    { timeoutMs: 60_000 },
  );
  await assertWritten(target, 'the reference image');
}

/**
 * Fit an image into an exact frame for use as a video start frame: the whole
 * image stays visible (no cropping of text), gaps are filled with a blurred,
 * enlarged copy of the image.
 */
export async function prepareStartFrame(
  file: string,
  target: string,
  width: number,
  height: number,
): Promise<void> {
  const W = Math.round(width / 2) * 2;
  const H = Math.round(height / 2) * 2;
  const graph =
    `[0:v]split=2[bgsrc][fgsrc];` +
    `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:4,eq=brightness=-0.08[bg];` +
    `[fgsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2,format=yuvj420p[out]`;
  try {
    await runFfmpeg(
      ['-i', file, '-frames:v', '1', '-filter_complex', graph, '-map', '[out]', '-q:v', '2', target],
      {
        timeoutMs: 60_000,
      },
    );
  } catch (err) {
    throw new Error(`Could not prepare the image for animation (${(err as Error).message.slice(0, 200)})`);
  }
  await assertWritten(target, 'the image to animate');
}
