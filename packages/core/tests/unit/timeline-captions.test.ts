import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../../src/timeline';
import {
  assColor,
  buildCaptionCues,
  buildOverlayCues,
  chunkWords,
  distributeWords,
  escapeAssText,
  toAss,
  toSrt,
} from '../../src/captions';
import { captionSettingsSchema } from '../../src/schemas';

const scenes = [
  { id: 'a', durationSec: 4, transition: 'fade' },
  { id: 'b', durationSec: 3, transition: 'cut' },
  { id: 'c', durationSec: 5, transition: 'fade' },
];

describe('timeline', () => {
  it('overlaps transitions and offsets by the intro', () => {
    const t = buildTimeline(scenes, { introSec: 2, outroSec: 2, transitionSec: 0.5 });
    expect(t.entries.map((e) => e.start)).toEqual([2, 5.5, 8.5]);
    expect(t.entries[0]!.transitionOutSec).toBe(0.5);
    expect(t.entries[1]!.transitionOutSec).toBe(0);
    expect(t.entries[2]!.transitionOutSec).toBe(0); // last scene
    expect(t.totalSec).toBe(2 + 4 + 3 + 5 - 0.5 + 2);
  });

  it('limits transitions on very short scenes', () => {
    const t = buildTimeline(
      [
        { id: 'a', durationSec: 1, transition: 'fade' },
        { id: 'b', durationSec: 1, transition: 'cut' },
      ],
      { transitionSec: 0.5 },
    );
    expect(t.entries[0]!.transitionOutSec).toBeLessThanOrEqual(0.34);
  });
});

describe('captions', () => {
  it('distributes script words across a window', () => {
    const w = distributeWords('one two three', 10, 3);
    expect(w).toHaveLength(3);
    expect(w[0]!.start).toBeGreaterThanOrEqual(10);
    expect(w[2]!.end).toBeLessThanOrEqual(13);
  });

  it('chunks words by count, punctuation and pauses', () => {
    const words = [
      { text: 'Big', start: 0, end: 0.2 },
      { text: 'night', start: 0.25, end: 0.5 },
      { text: 'out.', start: 0.55, end: 0.8 },
      { text: 'Tickets', start: 2, end: 2.3 },
      { text: 'now', start: 2.35, end: 2.5 },
    ];
    const cues = chunkWords(words, 2);
    expect(cues.map((c) => c.text)).toEqual(['Big night', 'out.', 'Tickets now']);
    expect(cues[0]!.end).toBeLessThanOrEqual(cues[1]!.start);
  });

  it('offsets per-scene voiceover timings onto the timeline', () => {
    const timeline = buildTimeline(scenes, { introSec: 1 });
    const cues = buildCaptionCues({
      timeline,
      mode: 'per-scene',
      source: 'voiceover',
      maxWordsPerLine: 3,
      scenes: [
        {
          id: 'a',
          voiceoverText: 'Hello there',
          onScreenText: '',
          words: [
            { word: 'Hello', start: 0.1, end: 0.4 },
            { word: 'there', start: 0.45, end: 0.8 },
          ],
        },
        { id: 'b', voiceoverText: '', onScreenText: 'BIG' },
        { id: 'c', voiceoverText: 'Book now', onScreenText: '' },
      ],
    });
    expect(cues[0]).toMatchObject({ text: 'Hello there', start: 1.1 });
    expect(cues[1]!.start).toBeGreaterThanOrEqual(timeline.entries[2]!.start);
    const overlays = buildOverlayCues(timeline, [
      { id: 'a', voiceoverText: '', onScreenText: '' },
      { id: 'b', voiceoverText: '', onScreenText: 'BIG' },
      { id: 'c', voiceoverText: '', onScreenText: '' },
    ]);
    expect(overlays).toEqual([
      { start: timeline.entries[1]!.start + 0.15, end: expect.any(Number), text: 'BIG' },
    ]);
  });

  it('uses global timings for full voiceovers', () => {
    const timeline = buildTimeline(scenes, { introSec: 2 });
    const cues = buildCaptionCues({
      timeline,
      mode: 'full',
      source: 'voiceover',
      maxWordsPerLine: 4,
      scenes: [],
      globalWords: [{ word: 'Welcome', start: 0, end: 0.5 }],
    });
    expect(cues[0]).toMatchObject({ text: 'Welcome', start: 2 });
  });

  it('writes valid SRT', () => {
    const srt = toSrt([
      { start: 1.5, end: 3.25, text: 'Hello', words: [] },
      { start: 3661.001, end: 3662, text: 'Later', words: [] },
    ]);
    expect(srt).toBe('1\n00:00:01,500 --> 00:00:03,250\nHello\n\n2\n01:01:01,001 --> 01:01:02,000\nLater\n');
  });

  it('writes ASS with styles, highlight tags and escaped text', () => {
    const settings = captionSettingsSchema.parse({});
    const ass = toAss(
      [
        {
          start: 0,
          end: 1,
          text: 'Go {now}',
          words: [
            { text: 'Go', start: 0, end: 0.4 },
            { text: '{now}', start: 0.5, end: 1 },
          ],
        },
      ],
      [{ start: 0, end: 2, text: 'HEADLINE' }],
      { width: 1080, height: 1920, settings, watermarkText: '@me', totalSec: 5 },
    );
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('Style: Caption,Montserrat,78,');
    expect(ass).toContain(`{\\c${assColor('#FFE600')}}GO{\\c${assColor('#FFFFFF')}}`);
    expect(ass).toContain('(NOW)');
    expect(ass).not.toMatch(/Dialogue:.*\{now\}/i);
    expect(ass).toContain(',Headline,');
    expect(ass).toContain(',Watermark,,0,0,0,,@me');
    expect(escapeAssText('a\\N{\\b1}')).toBe('a/N(/b1)');
    expect(assColor('#FF8000', 0.5)).toBe('&H800080FF');
  });
});
