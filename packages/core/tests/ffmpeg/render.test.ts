import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../../src/ffmpeg/exec';
import { probe, validateVideo } from '../../src/ffmpeg/probe';
import { renderVideo } from '../../src/ffmpeg/render';
import {
  analyzeLoudness,
  detectCuts,
  extractFrames,
  extractPalette,
  makeThumbnail,
} from '../../src/ffmpeg/analyze';
import { buildTimeline } from '../../src/timeline';
import { buildCaptionCues, toAss } from '../../src/captions';
import { captionSettingsSchema } from '../../src/schemas';
import { synthesizeMockWav } from '../../src/providers/tts/elevenlabs';
import { MockVideoProvider } from '../../src/providers/video/mock';
import { hasFfmpeg } from '../integration/env';
import { makePng } from '../fixtures/png';

let dir: string;
const f = (name: string) => path.join(dir, name);

async function hasFaststart(file: string): Promise<boolean> {
  const buf = await fs.readFile(file);
  const moov = buf.indexOf('moov');
  const mdat = buf.indexOf('mdat');
  return moov > 0 && mdat > 0 && moov < mdat;
}

describe.skipIf(!hasFfmpeg)('FFmpeg rendering', () => {
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-test-'));
    // Short fixture clips: landscape with audio, portrait without audio, a clip with a hard cut.
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=25:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-shortest',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      f('landscape.mp4'),
    ]);
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=720x1280:rate=30:duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      f('portrait.mp4'),
    ]);
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30:duration=2',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:size=640x360:rate=30:duration=2',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      f('cut.mp4'),
    ]);
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=4',
      '-c:a',
      'libmp3lame',
      f('music.mp3'),
    ]);
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.3', f('sfx.wav')]);
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=white:size=200x100', '-frames:v', '1', f('logo.png')]);
    await fs.writeFile(f('vo1.wav'), synthesizeMockWav('Summer is back on the rooftop').wav);
    await fs.writeFile(f('vo2.wav'), synthesizeMockWav('Get your tickets now').wav);
  });

  it('renders a final 1080x1920 H.264/AAC export with every stage enabled', async () => {
    const scenes = [
      { id: 'a', durationSec: 3, transition: 'fade' },
      { id: 'b', durationSec: 2.5, transition: 'slideleft' },
      { id: 'c', durationSec: 2, transition: 'cut' },
    ];
    const timeline = buildTimeline(scenes, { introSec: 1.5, outroSec: 1.5 });
    const settings = captionSettingsSchema.parse({});
    const cues = buildCaptionCues({
      timeline,
      mode: 'per-scene',
      source: 'script',
      maxWordsPerLine: 3,
      scenes: [
        { id: 'a', voiceoverText: 'Summer is back on the rooftop', onScreenText: 'TONIGHT' },
        { id: 'b', voiceoverText: 'Get your tickets now', onScreenText: '' },
        { id: 'c', voiceoverText: '', onScreenText: '' },
      ],
    });
    await fs.writeFile(
      f('captions.ass'),
      toAss(cues, [{ start: 1.6, end: 3, text: 'TONIGHT {x}' }], {
        width: 1080,
        height: 1920,
        settings,
        watermarkText: '@studio',
        totalSec: timeline.totalSec,
      }),
    );
    const out = f('final.mp4');
    const progress: number[] = [];
    const result = await renderVideo({
      mode: 'final',
      width: 1080,
      height: 1920,
      fps: 30,
      timeline,
      scenes: [
        { clipPath: f('landscape.mp4'), durationSec: 3 },
        { clipPath: f('portrait.mp4'), durationSec: 2.5 }, // shorter than scene: extended with tpad
        { clipPath: f('landscape.mp4'), durationSec: 2 }, // longer than scene: trimmed
      ],
      intro: {
        title: 'Rooftop Sessions',
        subtitle: 'Presents',
        backgroundColor: '#7C3AED',
        textColor: '#FFFFFF',
        fontFamily: 'Montserrat',
        logoPath: f('logo.png'),
        durationSec: 1.5,
      },
      outro: {
        title: 'Get tickets – link in bio',
        subtitle: '@rooftop',
        backgroundColor: '#111827',
        textColor: '#FFFFFF',
        fontFamily: 'Montserrat',
        durationSec: 1.5,
      },
      originalAudio: true,
      originalVolume: 0.5,
      voiceovers: [
        { path: f('vo1.wav'), startSec: timeline.entries[0]!.start + 0.1, volume: 1 },
        { path: f('vo2.wav'), startSec: timeline.entries[1]!.start + 0.1, volume: 1 },
      ],
      music: { path: f('music.mp3'), volume: 0.4, loop: true, fadeInSec: 1, fadeOutSec: 1.5, duck: true },
      sfx: [{ path: f('sfx.wav'), atSec: 2, volume: 0.8 }],
      assPath: f('captions.ass'),
      logo: { path: f('logo.png'), position: 'top-right', scale: 0.18, opacity: 0.8 },
      outPath: out,
      tempDir: dir,
      onProgress: (p) => progress.push(p),
    });
    const info = await probe(out);
    expect(info.video).toMatchObject({
      codec: 'h264',
      width: 1080,
      height: 1920,
      fps: 30,
      pixFmt: 'yuv420p',
    });
    expect(info.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(Math.abs(info.durationSec - timeline.totalSec)).toBeLessThan(0.35);
    expect(result.durationSec).toBeCloseTo(timeline.totalSec, 1);
    expect(await hasFaststart(out)).toBe(true);
    expect(Math.max(...progress)).toBeGreaterThan(0.9);
    const loud = await analyzeLoudness(out);
    expect(loud.integratedLufs).toBeGreaterThan(-20);
  });

  it('renders a low-resolution landscape preview from portrait footage', async () => {
    const timeline = buildTimeline([
      { id: 'a', durationSec: 2, transition: 'cut' },
      { id: 'b', durationSec: 2, transition: 'cut' },
    ]);
    const out = f('preview.mp4');
    await renderVideo({
      mode: 'preview',
      width: 960,
      height: 540,
      fps: 30,
      timeline,
      scenes: [
        { clipPath: f('portrait.mp4'), durationSec: 2 },
        { clipPath: f('landscape.mp4'), durationSec: 2 },
      ],
      originalAudio: false,
      originalVolume: 1,
      voiceovers: [],
      sfx: [],
      outPath: out,
      tempDir: dir,
    });
    const info = await probe(out);
    expect(info.video).toMatchObject({ width: 960, height: 540, fps: 30 });
    expect(info.audio?.codec).toBe('aac');
    expect(info.durationSec).toBeGreaterThan(3.7);
  });

  it('rejects invalid clips with a clear error', async () => {
    await fs.writeFile(f('broken.mp4'), 'not a video');
    const timeline = buildTimeline([{ id: 'a', durationSec: 2, transition: 'cut' }]);
    await expect(
      renderVideo({
        mode: 'preview',
        width: 540,
        height: 960,
        fps: 30,
        timeline,
        scenes: [{ clipPath: f('broken.mp4'), durationSec: 2 }],
        originalAudio: false,
        originalVolume: 1,
        voiceovers: [],
        sfx: [],
        outPath: f('x.mp4'),
        tempDir: dir,
      }),
    ).rejects.toThrow(/Scene 1: clip is not a valid video/);
  });

  it('analyses reference footage (cuts, frames, palette, loudness)', async () => {
    const cuts = await detectCuts(f('cut.mp4'));
    expect(cuts.length).toBe(1);
    expect(cuts[0]).toBeGreaterThan(1.8);
    expect(cuts[0]).toBeLessThan(2.2);
    const frames = await extractFrames(f('cut.mp4'), [0.5, 3], dir);
    expect(frames).toHaveLength(2);
    const palette = await extractPalette(frames);
    expect(palette.length).toBeGreaterThan(0);
    expect(
      palette.some(
        (c) => /^#0000[A-F0-9]{2}$/.test(c) || c === '#0000FF' || c === '#0020FF' || c.endsWith('FF'),
      ),
    ).toBe(true);
    const loud = await analyzeLoudness(f('landscape.mp4'));
    expect(typeof loud.integratedLufs).toBe('number');
    await makeThumbnail(f('landscape.mp4'), f('thumb.jpg'));
    expect((await fs.stat(f('thumb.jpg'))).size).toBeGreaterThan(500);
  });

  it('fails clearly on corrupt images instead of producing empty thumbnails', async () => {
    const good = makePng(40, 20, [10, 200, 30, 255]);
    await fs.writeFile(f('good.png'), good);
    await makeThumbnail(f('good.png'), f('good.jpg'), 0);
    expect((await extractPalette([f('good.jpg')])).length).toBeGreaterThan(0);
    const corrupt = Buffer.from(good);
    corrupt.writeUInt32BE(0x7fffffff, 33); // break the IDAT chunk length
    await fs.writeFile(f('corrupt.png'), corrupt);
    await expect(makeThumbnail(f('corrupt.png'), f('corrupt.jpg'), 0)).rejects.toThrow(/Could not decode/);
  });

  it('mock provider produces a valid labelled clip', async () => {
    const p = new MockVideoProvider({ delayMs: 0 });
    const job = await p.createVideo({ prompt: 'Neon rooftop', aspectRatio: '9:16', durationSec: 2 });
    const video = await p.downloadResult(job.providerJobId);
    await fs.writeFile(f('mock.mp4'), video.data);
    const info = await validateVideo(f('mock.mp4'));
    expect(info.video).toMatchObject({ width: 720, height: 1280 });
    expect(info.durationSec).toBeGreaterThan(1.8);
  });
});
