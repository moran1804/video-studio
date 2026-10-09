import { runFfprobe } from './exec';

export interface ProbeResult {
  durationSec: number;
  formatName?: string;
  sizeBytes?: number;
  video?: { codec: string; width: number; height: number; fps: number; pixFmt?: string; rotation?: number };
  audio?: { codec: string; sampleRate: number; channels: number };
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}

function parseRate(rate?: string): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !d) return Number(rate) || 0;
  return n / d;
}

export function parseProbeJson(json: unknown): ProbeResult {
  const data = json as {
    streams?: RawStream[];
    format?: { duration?: string; format_name?: string; size?: string };
  };
  const streams = data.streams ?? [];
  // Prefer real video over embedded cover art; plain image files only have an image stream.
  const v =
    streams.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg' && s.codec_name !== 'png') ??
    streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0;
  const rotation =
    v?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ??
    (v?.tags?.rotate ? Number(v.tags.rotate) : undefined);
  let width = v?.width ?? 0;
  let height = v?.height ?? 0;
  if (rotation && Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return {
    durationSec: duration,
    formatName: data.format?.format_name,
    sizeBytes: data.format?.size ? Number(data.format.size) : undefined,
    video: v
      ? {
          codec: v.codec_name ?? 'unknown',
          width,
          height,
          fps: Math.round((parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate)) * 100) / 100,
          pixFmt: v.pix_fmt,
          rotation,
        }
      : undefined,
    audio: a
      ? {
          codec: a.codec_name ?? 'unknown',
          sampleRate: Number(a.sample_rate ?? 0),
          channels: a.channels ?? 0,
        }
      : undefined,
  };
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await runFfprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  return parseProbeJson(JSON.parse(stdout.toString('utf8')));
}

export function aspectRatioLabel(width: number, height: number): string {
  if (!width || !height) return 'unknown';
  const r = width / height;
  const known: [string, number][] = [
    ['9:16', 9 / 16],
    ['4:5', 4 / 5],
    ['1:1', 1],
    ['4:3', 4 / 3],
    ['16:9', 16 / 9],
    ['21:9', 21 / 9],
  ];
  const best = known.sort((a, b) => Math.abs(a[1] - r) - Math.abs(b[1] - r))[0]!;
  return Math.abs(best[1] - r) < 0.03 ? best[0] : `${width}:${height}`;
}

/** Validate that a file is a decodable video with sensible properties. */
export async function validateVideo(file: string): Promise<ProbeResult> {
  const p = await probe(file);
  if (!p.video) throw new Error('File contains no video stream');
  if (p.video.width < 16 || p.video.height < 16) throw new Error('Video resolution is too small');
  if (p.durationSec <= 0.1) throw new Error('Video has no duration');
  return p;
}
