import { COMPOSURE_KINDS } from '@cursed/shared';
import { scoreError, type ComposureChallenge } from './challenge.js';

/**
 * Hold your breath: for exactly as long as you were shown, and let it go.
 *
 * The second kind, and the one that proves the first was not a special case.
 * Hold a key down; a guide fills while you hold it but fades out partway, so
 * the last of it has to be counted rather than watched. Release on the beat.
 *
 * Judged on the time between the key going down and coming up — both crossed
 * the same connection, so latency cancels here too.
 */

export const HOLD = {
  /** How long to hold, in milliseconds. */
  holdMs: { min: 2_200, max: 4_200 },
  /** Time to start holding, after the challenge is issued. */
  graceMs: 5_000,
  tightMs: 150,
  looseMs: 700,
} as const;

export interface HoldSpec {
  [key: string]: number | number[];
  holdMs: number;
}

export const holdChallenge: ComposureChallenge<HoldSpec> = {
  kind: COMPOSURE_KINDS.HOLD,

  issue(rng) {
    const holdMs = HOLD.holdMs.min + rng.nextInt(HOLD.holdMs.max - HOLD.holdMs.min + 1);
    return { spec: { holdMs }, durationMs: HOLD.graceMs + holdMs * 2 };
  },

  judge(spec, inputs, final) {
    const down = inputs.find((i) => i.input === 'DOWN');
    const up = down ? inputs.find((i) => i.input === 'UP' && i.at >= down.at) : undefined;
    if (!down || !up) return final ? 0 : null;
    return scoreError(up.at - down.at - spec.holdMs, HOLD.tightMs, HOLD.looseMs);
  },
};
