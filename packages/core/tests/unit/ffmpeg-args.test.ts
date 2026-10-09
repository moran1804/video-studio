import { describe, expect, it } from 'vitest';
import { buildComposeGraph, buildNormalizeArgs } from '../../src/ffmpeg/render';
import { editingStats, frameTimestamps, parseEbur128, parseShowinfoTimes } from '../../src/ffmpeg/analyze';
import { aspectRatioLabel, parseProbeJson } from '../../src/ffmpeg/probe';
import { buildTimeline } from '../../src/timeline';

describe('ffmpeg argument builders', () => {
  it('normalises clips with argument arrays only', () => {
    const args = buildNormalizeArgs(
      { clipPath: '/data/x; rm -rf /.mp4', durationSec: 4, hasAudio: true },
      {
        width: 1080,
        height: 1920,
        fps: 30,
        originalAudio: false,
        originalVolume: 1,
        mode: 'final',
        out: '/tmp/o.mkv',
      },
    );
    expect(args[args.indexOf('-i') + 1]).toBe('/data/x; rm -rf /.mp4'); // passed verbatim as one argv entry
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920');
    expect(graph).toContain('fps=30');
    expect(graph).toContain('tpad=stop_mode=clone:stop_duration=4.000');
    expect(graph).toContain('[1:a]atrim'); // silent track when original audio is muted
  });

  it('composes transitions, ducking, captions and loudness normalisation', () => {
    const timeline = buildTimeline([
      { id: 'a', durationSec: 4, transition: 'fade' },
      { id: 'b', durationSec: 4, transition: 'cut' },
      { id: 'c', durationSec: 4, transition: 'cut' },
    ]);
    const { graph, inputs, totalSec } = buildComposeGraph(
      {
        mode: 'final',
        width: 1080,
        height: 1920,
        fps: 30,
        timeline,
        originalAudio: false,
        originalVolume: 1,
        voiceovers: [
          { path: '/v1.wav', startSec: 0.1, volume: 1 },
          { path: '/v2.wav', startSec: 4, volume: 1 },
        ],
        music: { path: '/m.mp3', volume: 0.3, loop: true, fadeInSec: 1, fadeOutSec: 2, duck: true },
        sfx: [{ path: '/s.wav', atSec: 2, volume: 1 }],
        assPath: '/data/temp/render-1/captions.ass',
        logo: { path: '/logo.png', position: 'top-right', scale: 0.2, opacity: 0.8 },
        outPath: '/out.mp4',
      },
      [
        { path: '/s0.mkv', durationSec: 4, transition: 'fade', transitionSec: 0.5 },
        { path: '/s1.mkv', durationSec: 4, transition: 'cut', transitionSec: 0 },
        { path: '/s2.mkv', durationSec: 4, transition: 'cut', transitionSec: 0 },
      ],
    );
    expect(totalSec).toBeCloseTo(11.5);
    expect(graph).toContain('xfade=transition=fade:duration=0.500:offset=3.500');
    expect(graph).toContain('acrossfade=d=0.500');
    expect(graph).toContain('concat=n=2:v=1:a=0');
    expect(graph).toContain('ass=/data/temp/render-1/captions.ass');
    expect(graph).toContain('sidechaincompress');
    expect(graph).toContain('adelay=4000|4000');
    expect(graph).toContain('loudnorm=I=-14');
    expect(graph).toContain('colorchannelmixer=aa=0.80');
    expect(inputs).toContain('-stream_loop');
    expect(inputs.filter((a) => a === '-i')).toHaveLength(3 + 1 + 2 + 1 + 1);
  });

  it('refuses unsafe caption paths in filter graphs', () => {
    expect(() =>
      buildComposeGraph(
        {
          mode: 'preview',
          width: 540,
          height: 960,
          fps: 30,
          timeline: buildTimeline([]),
          originalAudio: false,
          originalVolume: 1,
          voiceovers: [],
          sfx: [],
          assPath: "/tmp/x',drawtext=text=pwned",
          outPath: '/o.mp4',
        },
        [{ path: '/s0.mkv', durationSec: 2, transition: 'cut', transitionSec: 0 }],
      ),
    ).toThrow(/unsafe/);
  });
});

describe('analysis parsers', () => {
  it('parses showinfo cut times', () => {
    const stderr =
      '[Parsed_showinfo_2 @ 0x] n:   0 pts:  12345 pts_time:1.5   pos:\n[Parsed_showinfo_2] n:1 pts_time:1.55 \n n:2 pts_time:4.2';
    expect(parseShowinfoTimes(stderr)).toEqual([1.5, 4.2]);
  });

  it('computes editing pace and frame sampling', () => {
    expect(editingStats([1, 2, 3, 4], 5)).toMatchObject({
      shotCount: 5,
      averageShotLengthSec: 1,
      pace: 'very fast',
    });
    expect(editingStats([], 12).pace).toBe('slow');
    const t = frameTimestamps([2, 4], 6, 8);
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...t)).toBeLessThan(6);
  });

  it('parses ebur128 summaries', () => {
    const out = parseEbur128(
      '...\nSummary:\n\n  Integrated loudness:\n    I:         -9.8 LUFS\n  Loudness range:\n    LRA:         5.2 LU\n',
    );
    expect(out).toEqual({ integratedLufs: -9.8, loudnessRange: 5.2, energy: 'high' });
  });

  it('parses ffprobe JSON including rotation', () => {
    const p = parseProbeJson({
      format: { duration: '8.0', format_name: 'mov,mp4' },
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30000/1001',
          side_data_list: [{ rotation: -90 }],
        },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
      ],
    });
    expect(p.video).toMatchObject({ width: 1080, height: 1920, fps: 29.97 });
    expect(p.audio).toMatchObject({ codec: 'aac', channels: 2 });
    expect(aspectRatioLabel(1080, 1920)).toBe('9:16');
    expect(aspectRatioLabel(1000, 777)).toBe('1000:777');
  });
});
