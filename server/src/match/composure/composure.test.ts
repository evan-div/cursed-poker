import { describe, expect, it } from 'vitest';
import { COMPOSURE, type ComposureInput } from '@cursed/shared';
import { SeededRandomSource } from '../../poker/index.js';
import {
  BREATH,
  HOLD,
  beginComposure,
  breathChallenge,
  canBegin,
  composureInput,
  composureView,
  createComposure,
  expireComposure,
  holdChallenge,
  visibleStress,
  type ComposureInputRecord,
} from './index.js';
import type { BreathSpec } from './breath.js';

/**
 * Composure: the two minigames, and what a result does.
 *
 * The property every kind has to have is the first describe block's last test:
 * a constant delay on every input — which is what latency is — changes nothing.
 * Judging on intervals is what lets the server time inputs by arrival without
 * punishing somebody for where they live.
 */

const T0 = 1_000_000;
const rec = (input: ComposureInput, at: number): ComposureInputRecord => ({ input, at });

function tapsFor(spec: BreathSpec, start: number, error = 0): ComposureInputRecord[] {
  const taps = [rec('DOWN', start)];
  let at = start;
  spec.gapsMs.forEach((gap, i) => {
    at += gap + (i % 2 === 0 ? error : -error);
    taps.push(rec('DOWN', at));
  });
  return taps;
}

describe('steady breath', () => {
  const { spec } = breathChallenge.issue(new SeededRandomSource(3));

  it('draws an uneven, slow rhythm', () => {
    expect(spec.gapsMs).toHaveLength(BREATH.beats - 1);
    for (const gap of spec.gapsMs) {
      expect(gap).toBeGreaterThanOrEqual(BREATH.gapMs.min);
      expect(gap).toBeLessThanOrEqual(BREATH.gapMs.max);
    }
    expect(new Set(spec.gapsMs).size).toBeGreaterThan(1);
  });

  it('scores a perfect rhythm perfectly, and a sloppy one worse', () => {
    expect(breathChallenge.judge(spec, tapsFor(spec, T0), false)).toBe(1);
    const sloppy = breathChallenge.judge(spec, tapsFor(spec, T0, 200), false)!;
    expect(sloppy).toBeGreaterThan(0);
    expect(sloppy).toBeLessThan(0.7);
    expect(breathChallenge.judge(spec, tapsFor(spec, T0, 600), false)).toBe(0);
  });

  it('waits for every beat, and judges what it has when time runs out', () => {
    const half = tapsFor(spec, T0).slice(0, 3);
    expect(breathChallenge.judge(spec, half, false)).toBeNull();
    // Two of five intervals, both perfect.
    expect(breathChallenge.judge(spec, half, true)).toBeCloseTo(2 / 5, 9);
    expect(breathChallenge.judge(spec, [], true)).toBe(0);
  });

  it('ignores key releases', () => {
    const taps = tapsFor(spec, T0).flatMap((t) => [t, rec('UP', t.at + 90)]);
    expect(breathChallenge.judge(spec, taps, false)).toBe(1);
  });

  it('does not care how far away the player is', () => {
    const near = breathChallenge.judge(spec, tapsFor(spec, T0, 100), false);
    const far = breathChallenge.judge(spec, tapsFor(spec, T0 + 450, 100), false);
    expect(far).toBe(near);
  });
});

describe('holding a breath', () => {
  const { spec } = holdChallenge.issue(new SeededRandomSource(8));

  it('draws a hold of a few seconds', () => {
    expect(spec.holdMs).toBeGreaterThanOrEqual(HOLD.holdMs.min);
    expect(spec.holdMs).toBeLessThanOrEqual(HOLD.holdMs.max);
  });

  it('scores the length of the hold', () => {
    const hold = (ms: number) =>
      holdChallenge.judge(spec, [rec('DOWN', T0), rec('UP', T0 + ms)], false);
    expect(hold(spec.holdMs)).toBe(1);
    expect(hold(spec.holdMs + 100)).toBe(1);
    expect(hold(spec.holdMs - 400)!).toBeLessThan(0.6);
    expect(hold(spec.holdMs * 2)).toBe(0);
  });

  it('is still running while held, and nothing if never let go', () => {
    expect(holdChallenge.judge(spec, [rec('DOWN', T0)], false)).toBeNull();
    expect(holdChallenge.judge(spec, [rec('DOWN', T0)], true)).toBe(0);
  });

  it('ignores a release from a key held before it started', () => {
    const inputs = [rec('UP', T0 - 50), rec('DOWN', T0), rec('UP', T0 + spec.holdMs)];
    expect(holdChallenge.judge(spec, inputs, false)).toBe(1);
  });

  it('does not care how far away the player is', () => {
    const at = (start: number) =>
      holdChallenge.judge(spec, [rec('DOWN', start), rec('UP', start + spec.holdMs + 300)], false);
    expect(at(T0 + 380)).toBe(at(T0));
  });
});

describe('a seat steadying itself', () => {
  const kinds = [breathChallenge];

  it('issues one challenge at a time, then makes you wait', () => {
    const state = createComposure();
    const rng = new SeededRandomSource(1);
    const challenge = beginComposure(state, 2, kinds, rng, T0);
    expect(canBegin(state, 2, T0)).toBe('BUSY');
    expect(() => beginComposure(state, 2, kinds, rng, T0)).toThrow('BUSY');
    // Somebody else may, meanwhile.
    expect(canBegin(state, 3, T0)).toBeNull();

    for (const tap of tapsFor(challenge.spec as BreathSpec, T0 + 500)) {
      composureInput(state, 2, challenge.id, tap.input, kinds, tap.at);
    }
    const done = composureView(state, 2, T0 + 10_000);
    expect(done.challenge).toBeNull();
    expect(done.result?.outcome).toBe('STEADIED');
    expect(canBegin(state, 2, T0 + 10_000)).toBe('COOLING_DOWN');
    expect(canBegin(state, 2, done.readyAt)).toBeNull();
  });

  it('pays no attention to inputs for a challenge it is not running', () => {
    const state = createComposure();
    const challenge = beginComposure(state, 0, kinds, new SeededRandomSource(1), T0);
    for (let i = 0; i < 6; i++) {
      expect(composureInput(state, 0, 'c999', 'DOWN', kinds, T0 + i * 1_000)).toBeNull();
      expect(composureInput(state, 1, challenge.id, 'DOWN', kinds, T0 + i * 1_000)).toBeNull();
    }
    expect(state.seats.find((s) => s.seatIndex === 0)!.challenge!.inputs).toHaveLength(0);
  });

  it('judges a challenge nobody finished, and finds it wanting', () => {
    const state = createComposure();
    const challenge = beginComposure(state, 0, kinds, new SeededRandomSource(1), T0);
    expect(expireComposure(state, kinds, challenge.expiresAt - 1)).toHaveLength(0);
    const [ended] = expireComposure(state, kinds, challenge.expiresAt);
    expect(ended?.result.outcome).toBe('SHAKEN');
    expect(ended?.result.quality).toBe(0);
  });

  it('bounds how much a challenge will listen to', () => {
    const state = createComposure();
    const challenge = beginComposure(state, 0, [holdChallenge], new SeededRandomSource(1), T0);
    for (let i = 0; i < 500; i++) composureInput(state, 0, challenge.id, 'DOWN', [holdChallenge], T0 + i);
    expect(state.seats[0]!.challenge!.inputs.length).toBeLessThanOrEqual(32);
  });
});

describe('what a result does to what the table sees', () => {
  function withResult(quality: number) {
    const state = createComposure();
    state.seats.push({
      seatIndex: 0,
      challenge: null,
      readyAt: 0,
      result: {
        outcome: quality >= COMPOSURE.passAt ? 'STEADIED' : 'SHAKEN',
        quality,
        at: T0,
        until: T0 + (quality >= COMPOSURE.passAt ? COMPOSURE.steadiedMs : COMPOSURE.shakenMs),
      },
    });
    return state;
  }

  it('hides fear after a success, and better the better it went', () => {
    const passed = visibleStress(withResult(COMPOSURE.passAt), 0, 0.8, T0);
    const best = visibleStress(withResult(1), 0, 0.8, T0);
    expect(passed).toBeLessThan(0.8);
    expect(best).toBeLessThan(passed);
    expect(best).toBeCloseTo(0.8 * (1 - COMPOSURE.steadiedHides.atBest), 9);
  });

  it('wears off', () => {
    const state = withResult(1);
    const early = visibleStress(state, 0, 0.8, T0 + 1_000);
    const late = visibleStress(state, 0, 0.8, T0 + COMPOSURE.steadiedMs - 1_000);
    expect(late).toBeGreaterThan(early);
    expect(visibleStress(state, 0, 0.8, T0 + COMPOSURE.steadiedMs)).toBe(0.8);
  });

  it('makes a failure look worse than not trying', () => {
    const shaken = visibleStress(withResult(0.2), 0, 0.4, T0);
    expect(shaken).toBeGreaterThan(0.4);
    expect(shaken).toBeLessThanOrEqual(1);
    expect(visibleStress(withResult(0.2), 0, 0.4, T0 + COMPOSURE.shakenMs)).toBe(0.4);
  });

  it('leaves everybody else exactly as they were', () => {
    expect(visibleStress(withResult(1), 3, 0.7, T0)).toBe(0.7);
  });

  it('only ever tells its owner', () => {
    const state = withResult(1);
    expect(composureView(state, 0, T0).result?.outcome).toBe('STEADIED');
    expect(composureView(state, 1, T0).result).toBeNull();
    expect(composureView(state, null, T0).result).toBeNull();
  });
});
