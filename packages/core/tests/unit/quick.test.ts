import { describe, expect, it } from 'vitest';
import { planClipDurations, quickOptionsSchema } from '../../src/jobs/quick';
import { normalizeQuickPlan } from '../../src/providers/llm/openai';

describe('one-shot videos', () => {
  it('splits the requested length into clips the model supports', () => {
    expect(planClipDurations(8, [4, 6, 8])).toEqual([8]);
    expect(planClipDurations(5, [4, 6, 8])).toEqual([6]);
    expect(planClipDurations(15, [4, 6, 8])).toEqual([8, 8]);
    expect(planClipDurations(30, [5, 10])).toEqual([10, 10, 10]);
    expect(planClipDurations(20, [4, 6, 8])).toEqual([8, 8, 8]);
  });

  it('forces the clip count and strips narration without voiceover', () => {
    const clips = [
      { durationSec: 8, animatesImage: false },
      { durationSec: 8, animatesImage: false },
    ];
    const plan = normalizeQuickPlan(
      { title: ' ', clips: [{ prompt: 'A', voiceoverText: 'Hello', onScreenText: 'Hi' }] },
      { clips, voiceover: false, request: 'Party teaser' },
    );
    expect(plan.title).toBe('Party teaser');
    expect(plan.clips).toHaveLength(2);
    expect(plan.clips.every((c) => c.voiceoverText === '')).toBe(true);
  });

  it('drops on-screen headlines unless the user asked for them', () => {
    const clips = [{ durationSec: 8, animatesImage: false }];
    const raw = { title: 'T', clips: [{ prompt: 'A', voiceoverText: '', onScreenText: 'Walk in' }] };
    expect(normalizeQuickPlan(raw, { clips, voiceover: false, request: 'r' }).clips[0]!.onScreenText).toBe(
      '',
    );
    expect(
      normalizeQuickPlan(raw, { clips, voiceover: false, request: 'r', onScreenText: true }).clips[0]!
        .onScreenText,
    ).toBe('Walk in');
    expect(quickOptionsSchema.parse({ prompt: 'A party teaser' }).onScreenText).toBe(false);
  });

  it('validates Create screen options', () => {
    expect(() => quickOptionsSchema.parse({ prompt: 'x' })).toThrow(/Describe the video/);
    expect(quickOptionsSchema.parse({ prompt: 'A party teaser' })).toMatchObject({
      voiceover: false,
      captions: true,
      music: false,
      logo: true,
    });
  });
});
