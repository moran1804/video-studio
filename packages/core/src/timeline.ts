import type { Transition } from './schemas';

export interface TimelineScene {
  id: string;
  durationSec: number;
  transition: string;
}

export interface TimelineEntry {
  id: string;
  index: number;
  /** Start time of the scene in the final video (seconds). */
  start: number;
  durationSec: number;
  /** Duration of the transition from this scene into the next (0 for cuts / last scene). */
  transitionOutSec: number;
  transition: Transition | 'cut';
}

export interface Timeline {
  entries: TimelineEntry[];
  introSec: number;
  outroSec: number;
  totalSec: number;
}

export const DEFAULT_TRANSITION_SEC = 0.5;

/**
 * Compute where every scene lands in the final render. Transitions overlap
 * adjacent scenes (xfade), so each non-cut transition shortens the total.
 * Used identically by the renderer, caption builder and voiceover placement.
 */
export function buildTimeline(
  scenes: TimelineScene[],
  opts: { introSec?: number; outroSec?: number; transitionSec?: number } = {},
): Timeline {
  const introSec = opts.introSec ?? 0;
  const outroSec = opts.outroSec ?? 0;
  const baseT = opts.transitionSec ?? DEFAULT_TRANSITION_SEC;
  const entries: TimelineEntry[] = [];
  let t = introSec;
  scenes.forEach((s, i) => {
    const next = scenes[i + 1];
    const transition = (s.transition || 'cut') as Transition;
    let td = 0;
    if (next && transition !== 'cut') {
      td = Math.min(baseT, s.durationSec / 3, next.durationSec / 3);
      td = Math.max(0, Math.round(td * 100) / 100);
    }
    entries.push({
      id: s.id,
      index: i,
      start: +t.toFixed(3),
      durationSec: s.durationSec,
      transitionOutSec: td,
      transition: td > 0 ? transition : 'cut',
    });
    t += s.durationSec - td;
  });
  return { entries, introSec, outroSec, totalSec: +(t + outroSec).toFixed(3) };
}
