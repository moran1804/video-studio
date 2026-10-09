import { describe, expect, it } from 'vitest';
import { animatePrompt, normalizeStoryboard, sceneUpdateSchema } from '../../src/schemas';
import { startFrameSize } from '../../src/providers/video/types';

const scene = (animateReferenceIndex: number) => ({
  purpose: 'Hook',
  durationSec: 4,
  visualDescription: 'Poster comes alive',
  prompt: 'Slow push-in on the poster',
  camera: 'push-in',
  lighting: 'neon',
  onScreenText: '',
  voiceoverText: '',
  transition: 'fade',
  audioDirection: '',
  referenceIndexes: [],
  animateReferenceIndex,
});

describe('animate this image', () => {
  it('keeps only animate indexes the user actually marked', () => {
    const out = normalizeStoryboard(
      { scenes: [scene(1), scene(0), scene(7), scene(-1)] },
      { targetDurationSec: 16, referenceCount: 3, animateIndexes: [1] },
    );
    expect(out.scenes.map((s) => s.animateReferenceIndex)).toEqual([1, -1, -1, -1]);
  });

  it('prefixes prompts with layout-preserving instructions once', () => {
    const p = animatePrompt('Neon lights flicker');
    expect(p).toMatch(/^Animate the provided image\. Keep all text, logos/);
    expect(p).toContain('Neon lights flicker');
    expect(animatePrompt(p)).toBe(p);
  });

  it('sizes start frames per aspect ratio', () => {
    expect(startFrameSize('9:16')).toEqual([720, 1280]);
    expect(startFrameSize('16:9')).toEqual([1280, 720]);
    expect(startFrameSize('4:5')).toEqual([864, 1080]);
  });

  it('accepts clearing or setting the animate image on a scene', () => {
    expect(sceneUpdateSchema.parse({ animateAssetId: null })).toEqual({ animateAssetId: null });
    expect(() => sceneUpdateSchema.parse({ animateAssetId: 'poster.png' })).toThrow();
  });
});
