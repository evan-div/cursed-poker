import type { ComposureInput, ComposureKind, ComposureSpec } from '@cursed/shared';
import type { RandomSource } from '../../poker/index.js';

/**
 * The contract every composure minigame meets.
 *
 * Issue, input, judge — and nothing else. A kind draws its own parameters,
 * reads the inputs the server received for it, and says how well they went.
 * It is never told how frightened anybody is, what anybody holds, or what
 * happens to a seat's tells afterwards: the stress model is out of its reach
 * and it is out of the stress model's. That is what makes a new one a new file
 * and nothing more — see `composure.test.ts`, which plugs in a kind the game
 * has never heard of and runs it through a whole match.
 */

/** One input, as the server received it. `at` is the server's clock, always. */
export interface ComposureInputRecord {
  input: ComposureInput;
  at: number;
}

export interface ComposureChallenge<Spec extends ComposureSpec = ComposureSpec> {
  readonly kind: ComposureKind;

  /**
   * Draws a fresh challenge.
   *
   * From the composure source of chance, which is never the deck's — the same
   * separation the Dealer has. `durationMs` is how long the player has, from
   * issue, before it lapses and is judged on whatever arrived.
   */
  issue(rng: RandomSource): { spec: Spec; durationMs: number };

  /**
   * How it went, 0..1, or `null` while it is still going.
   *
   * `final` is set when time has run out: give a verdict on what there is.
   * Judge on intervals between inputs wherever possible rather than on
   * absolute times — both ends of an interval crossed the same connection, so
   * latency cancels and a player on a bad line is not punished for it.
   */
  judge(spec: Spec, inputs: readonly ComposureInputRecord[], final: boolean): number | null;
}

/** 1 inside `tight`, 0 beyond `loose`, a straight line between. */
export function scoreError(errorMs: number, tight: number, loose: number): number {
  const e = Math.abs(errorMs);
  if (!Number.isFinite(e) || e >= loose) return 0;
  if (e <= tight) return 1;
  return 1 - (e - tight) / (loose - tight);
}
