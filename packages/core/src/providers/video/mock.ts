import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { runFfmpeg } from '../../ffmpeg/exec';
import type { AspectRatio } from '../../schemas';
import type {
  GeneratedVideo,
  ProviderCapabilities,
  VideoGenerationRequest,
  VideoJob,
  VideoJobStatus,
  VideoProvider,
} from './types';

const MOCK_SIZES: Record<AspectRatio, [number, number]> = {
  '9:16': [720, 1280],
  '16:9': [1280, 720],
  '1:1': [720, 720],
  '4:5': [720, 900],
};

export const MOCK_FRAME_SIZES = MOCK_SIZES;

export const DEFAULT_FONT_FILE = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

interface MockJobData {
  ar: AspectRatio;
  d: number;
  l: string;
  t: number;
  f?: boolean;
  /** sha1 of a cached start-frame image (animate mode). */
  i?: string;
}

/** Wrap text to roughly `width` characters per line. */
export function wrapText(text: string, width = 22, maxLines = 6): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width && line) {
      lines.push(line);
      line = w;
    } else line = (line + ' ' + w).trim();
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.join('\n');
}

/**
 * Offline provider that renders a labelled test pattern with FFmpeg. The job
 * id encodes the request, so it survives worker restarts. Prompts containing
 * "[mock-fail]" fail, which is useful for exercising retry flows.
 */
export class MockVideoProvider implements VideoProvider {
  readonly id = 'mock' as const;
  readonly label = 'Mock';
  readonly model = 'mock-testsrc';

  constructor(private readonly opts: { delayMs?: number; imageCacheDir?: string } = {}) {}

  private imageDir(): string {
    return this.opts.imageCacheDir ?? path.join(os.tmpdir(), 'studio-mock-images');
  }

  capabilities(): ProviderCapabilities {
    return {
      durations: [2, 3, 4, 5, 6, 8, 10],
      aspectRatios: ['9:16', '16:9', '1:1', '4:5'],
      supportsImage: true,
      supportsTextOnly: true,
      supportsCancel: true,
      maxPromptChars: 4000,
      maxReferenceImages: 3,
    };
  }

  async createVideo(request: VideoGenerationRequest): Promise<VideoJob> {
    const data: MockJobData = {
      ar: request.aspectRatio,
      d: Math.max(1, Math.min(10, Math.round(request.durationSec))),
      l: (request.label || request.prompt).slice(0, 140),
      t: Date.now(),
      f: request.prompt.includes('[mock-fail]') || undefined,
    };
    if (request.referenceImage) {
      // Keep the image on disk so the job id stays small and survives restarts.
      const sha = crypto.createHash('sha1').update(request.referenceImage.data).digest('hex');
      await fs.mkdir(this.imageDir(), { recursive: true });
      await fs.writeFile(path.join(this.imageDir(), `${sha}.jpg`), request.referenceImage.data);
      data.i = sha;
    }
    return {
      providerJobId: `mock_${Buffer.from(JSON.stringify(data)).toString('base64url')}`,
      provider: 'mock',
      submitted: { aspectRatio: data.ar, durationSec: data.d, model: this.model },
      estimatedCostUsd: 0,
    };
  }

  private decode(jobId: string): MockJobData {
    if (!jobId.startsWith('mock_')) throw new Error('Invalid mock job id');
    return JSON.parse(Buffer.from(jobId.slice(5), 'base64url').toString('utf8')) as MockJobData;
  }

  async getJobStatus(jobId: string): Promise<VideoJobStatus> {
    const data = this.decode(jobId);
    if (data.f) return { state: 'failed', error: 'Mock provider failure requested by prompt' };
    const elapsed = Date.now() - data.t;
    const delay = this.opts.delayMs ?? 1500;
    if (elapsed < delay) return { state: 'generating', progress: elapsed / delay };
    return { state: 'completed', progress: 1 };
  }

  async downloadResult(jobId: string): Promise<GeneratedVideo> {
    const data = this.decode(jobId);
    const [w, h] = MOCK_SIZES[data.ar] ?? MOCK_SIZES['9:16'];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mockvid-'));
    try {
      const image =
        data.i && /^[a-f0-9]{40}$/.test(data.i) ? path.join(this.imageDir(), `${data.i}.jpg`) : null;
      if (image && (await fs.stat(image).catch(() => null))) {
        return { data: await this.animateImage(image, w, h, data.d, dir), mimeType: 'video/mp4' };
      }
      const textFile = path.join(dir, 'label.txt');
      await fs.writeFile(textFile, wrapText(data.l, w > h ? 30 : 18));
      const hue = parseInt(crypto.createHash('md5').update(data.l).digest('hex').slice(0, 2), 16) / 255;
      const color = hslToHex(hue, 0.55, 0.35);
      const out = path.join(dir, 'out.mp4');
      // Size text from the short side so labels fit portrait and landscape frames.
      const fontSize = Math.round(Math.min(w, h) / 17);
      await runFfmpeg(
        [
          '-f',
          'lavfi',
          '-i',
          `testsrc2=size=${w}x${h}:rate=30:duration=${data.d}`,
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=220:sample_rate=48000:duration=${data.d}`,
          '-filter_complex',
          `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=${color}@0.7:t=fill,` +
            `drawtext=fontfile=${DEFAULT_FONT_FILE}:textfile=${textFile}:fontcolor=white:fontsize=${fontSize}:` +
            `line_spacing=${Math.round(fontSize / 3)}:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.45:boxborderw=24,` +
            `format=yuv420p[v];[1:a]volume=0.15[a]`,
          '-map',
          '[v]',
          '-map',
          '[a]',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '28',
          '-c:a',
          'aac',
          '-b:a',
          '96k',
          '-shortest',
          '-movflags',
          '+faststart',
          out,
        ],
        { timeoutMs: 120_000 },
      );
      return { data: await fs.readFile(out), mimeType: 'video/mp4' };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /** Slow "Ken Burns" push-in over the start frame – a stand-in for real image-to-video. */
  private async animateImage(
    image: string,
    w: number,
    h: number,
    seconds: number,
    dir: string,
  ): Promise<Buffer> {
    const out = path.join(dir, 'animated.mp4');
    const frames = seconds * 30;
    await runFfmpeg(
      [
        '-i',
        image,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=220:sample_rate=48000:duration=${seconds}`,
        '-filter_complex',
        `[0:v]scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},` +
          `zoompan=z='min(zoom+${(0.18 / frames).toFixed(5)},1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=30,` +
          `format=yuv420p[v];[1:a]volume=0.1[a]`,
        '-map',
        '[v]',
        '-map',
        '[a]',
        '-t',
        String(seconds),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '26',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-movflags',
        '+faststart',
        out,
      ],
      { timeoutMs: 180_000 },
    );
    return fs.readFile(out);
  }

  async cancelJob(): Promise<void> {
    /* nothing to cancel */
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'Mock provider is always available.' };
  }
}

function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `0x${f(0)}${f(8)}${f(4)}`;
}
