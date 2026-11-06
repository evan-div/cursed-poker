import { COMPOSURE_KINDS } from '@cursed/shared';
import { scoreError, type ComposureChallenge } from './challenge.js';

/**
 * Steady breath: tap out a slow rhythm against your own racing heart.
 *
 * The player is shown a breathing guide — a slow pulse, slightly uneven so it
 * cannot be done by counting — and taps along. Their own heartbeat is in their
 * ears the whole time, faster than the guide and getting in the way, which is
 * the whole difficulty: keeping a slow rhythm while your body insists on a
 * fast one is what composing yourself feels like.
 *
 * Judged on the gaps between taps, not when they landed, so a player's
 * latency costs them nothing. The first tap starts the rhythm and is free.
 */

export const BREATH = {
  /** Taps per challenge. The first starts the clock; the rest are judged. */
  beats: 6,
  /** Each gap between beats, in milliseconds. */
  gapMs: { min: 900, max: 1_500 },
  /** Time to make the first tap, after the challenge is issued. */
  graceMs: 5_000,
  /** An interval within this of its target is perfect; beyond `loose` is nothing. */
  tightMs: 80,
  looseMs: 320,
} as const;

export interface BreathSpec {
  [key: string]: number | number[];
  /** The target gap before each beat after the first. */
  gapsMs: number[];
}

export const breathChallenge: ComposureChallenge<BreathSpec> = {
  kind: COMPOSURE_KINDS.BREATH,

  issue(rng) {
    const span = BREATH.gapMs.max - BREATH.gapMs.min;
    const gapsMs = Array.from({ length: BREATH.beats - 1 }, () => BREATH.gapMs.min + rng.nextInt(span + 1));
    const total = gapsMs.reduce((a, b) => a + b, 0);
    return { spec: { gapsMs }, durationMs: BREATH.graceMs + total + 1_500 };
  },

  judge(spec, inputs, final) {
    const taps = inputs.filter((i) => i.input === 'DOWN').map((i) => i.at);
    if (taps.length < spec.gapsMs.length + 1 && !final) return null;

    const scores = spec.gapsMs.map((target, i) => {
      const from = taps[i];
      const to = taps[i + 1];
      if (from === undefined || to === undefined) return 0;
      return scoreError(to - from - target, BREATH.tightMs, BREATH.looseMs);
    });
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  },
};
