import { describe, expect, it } from 'vitest';
import {
  briefSchema,
  createProjectSchema,
  normalizeStoryboard,
  sceneUpdateSchema,
  storyboardSchema,
} from '../../src/schemas';

const scene = (over: Record<string, unknown> = {}) => ({
  purpose: 'Hook',
  durationSec: 4,
  visualDescription: 'Close-up of a DJ',
  prompt: 'Cinematic close-up of a DJ',
  camera: 'push-in',
  lighting: 'neon',
  onScreenText: 'TONIGHT',
  voiceoverText: 'Get ready',
  transition: 'fade',
  audioDirection: 'bass drop',
  referenceIndexes: [0],
  ...over,
});

describe('storyboard validation', () => {
  it('accepts a valid storyboard', () => {
    expect(storyboardSchema.parse({ scenes: [scene()] }).scenes).toHaveLength(1);
  });

  it('rejects unknown transitions and missing fields', () => {
    expect(() => storyboardSchema.parse({ scenes: [scene({ transition: 'star-wipe' })] })).toThrow();
    const { prompt: _p, ...noPrompt } = scene();
    expect(() => storyboardSchema.parse({ scenes: [noPrompt] })).toThrow();
    expect(() => storyboardSchema.parse({})).toThrow();
  });

  it('clamps durations, fixes prompts and filters reference indexes', () => {
    const out = normalizeStoryboard(
      {
        scenes: [
          scene({ durationSec: 0.3, prompt: '  ', referenceIndexes: [0, 5, -1] }),
          scene({ durationSec: 42 }),
        ],
      },
      { targetDurationSec: 10, referenceCount: 1, minSceneSec: 2, maxSceneSec: 8 },
    );
    expect(out.scenes[0]!.durationSec).toBeGreaterThanOrEqual(2);
    expect(out.scenes[1]!.durationSec).toBeLessThanOrEqual(8);
    expect(out.scenes[0]!.prompt).toBe('Close-up of a DJ');
    expect(out.scenes[0]!.referenceIndexes).toEqual([0]);
  });

  it('rescales total duration towards the target', () => {
    const out = normalizeStoryboard(
      { scenes: Array.from({ length: 5 }, () => scene({ durationSec: 2 })) },
      { targetDurationSec: 30, referenceCount: 0, maxSceneSec: 8 },
    );
    const total = out.scenes.reduce((a, s) => a + s.durationSec, 0);
    expect(total).toBeGreaterThanOrEqual(25);
    expect(total).toBeLessThanOrEqual(35);
  });

  it('rejects an empty storyboard', () => {
    expect(() => normalizeStoryboard({ scenes: [] }, { targetDurationSec: 10, referenceCount: 0 })).toThrow(
      /no scenes/,
    );
  });

  it('validates scene edits', () => {
    expect(sceneUpdateSchema.parse({ durationSec: 5, transition: 'cut' })).toEqual({
      durationSec: 5,
      transition: 'cut',
    });
    expect(() => sceneUpdateSchema.parse({ durationSec: 0 })).toThrow();
    expect(() => sceneUpdateSchema.parse({ provider: 'sora' })).toThrow();
    expect(() => sceneUpdateSchema.parse({ referenceAssetIds: ['not-a-uuid'] })).toThrow();
  });

  it('validates briefs and new projects', () => {
    expect(() => briefSchema.parse({ concept: 'x' })).toThrow();
    const p = createProjectSchema.parse({ name: ' Launch ', durationSec: '20' });
    expect(p).toMatchObject({
      name: 'Launch',
      durationSec: 20,
      aspectRatio: '9:16',
      platform: 'instagram_reels',
    });
    expect(() => createProjectSchema.parse({ name: '' })).toThrow();
    expect(() => createProjectSchema.parse({ name: 'x', aspectRatio: '21:9' })).toThrow();
  });
});
