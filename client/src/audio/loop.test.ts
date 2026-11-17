import { describe, expect, it } from 'vitest';
import { loopSeamlessly } from './loop.js';

/** A slow random walk, like the room tone: smooth, and ending nowhere near where it began. */
function wander(length: number): Float32Array {
  const out = new Float32Array(length);
  let value = 0;
  let state = 12345;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    value += (state / 4294967296 - 0.5 - value * 0.02) * 0.05;
    out[i] = value + i * 0.0004;
  }
  return out;
}

const largestStep = (samples: Float32Array): number => {
  let most = 0;
  for (let i = 1; i < samples.length; i++) most = Math.max(most, Math.abs(samples[i]! - samples[i - 1]!));
  return most;
};

describe('a loop', () => {
  it('clicks when it is simply played round and round', () => {
    // The thing being fixed, stated as a fact about the input: the jump from
    // the last sample back to the first is far bigger than any step inside it.
    const raw = wander(4_000);
    expect(Math.abs(raw[0]! - raw[raw.length - 1]!)).toBeGreaterThan(largestStep(raw) * 10);
  });

  it('wraps without a jump once it has been folded', () => {
    const raw = wander(4_000);
    const looped = loopSeamlessly(raw, 500);
    const wrap = Math.abs(looped[0]! - looped[looped.length - 1]!);
    // No worse than the sound's own largest step: the seam is not an event.
    expect(wrap).toBeLessThanOrEqual(largestStep(raw) * 1.5);
    expect(largestStep(looped)).toBeLessThanOrEqual(largestStep(raw) * 2.5);
  });

  it('gets shorter by the piece it folded in, and leaves the rest alone', () => {
    const raw = wander(2_000);
    const looped = loopSeamlessly(raw, 300);
    expect(looped).toHaveLength(1_700);
    for (let i = 300; i < 1_700; i += 97) expect(looped[i]).toBe(raw[i]);
  });

  it('does nothing to a sound it is asked not to fade', () => {
    const raw = wander(100);
    expect(Array.from(loopSeamlessly(raw, 0))).toEqual(Array.from(raw));
  });

  it('never folds more than half the sound into itself', () => {
    expect(loopSeamlessly(wander(100), 10_000)).toHaveLength(50);
  });
});
