import { describe, expect, it } from 'vitest';
import { fbm, seeded, valueNoise } from './noise.js';

/**
 * The randomness the room is painted with.
 *
 * Six players are looking at the same stain on the same felt. That is only true
 * if nothing here ever reaches for `Math.random`.
 */
describe('painted randomness', () => {
  it('gives the same sequence for the same seed, on every machine', () => {
    const a = seeded(1907);
    const b = seeded(1907);
    const first = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(first);
    // Pinned, so a change to the generator cannot quietly repaint the table.
    expect(first[0]).toBeCloseTo(0.23202, 4);
  });

  it('gives different sequences for different seeds', () => {
    const a = seeded(1);
    const b = seeded(2);
    expect(Array.from({ length: 8 }, () => a())).not.toEqual(Array.from({ length: 8 }, () => b()));
  });

  it('stays inside 0..1 and uses the range', () => {
    const random = seeded(7);
    const values = Array.from({ length: 4_000 }, () => random());
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    expect(Math.min(...values)).toBeLessThan(0.02);
    expect(Math.max(...values)).toBeGreaterThan(0.98);
  });
});

describe('noise', () => {
  it('is a function of where it is asked, and nothing else', () => {
    expect(valueNoise(3.7, 9.2, 5)).toBe(valueNoise(3.7, 9.2, 5));
    expect(fbm(3.7, 9.2, 4, 5)).toBe(fbm(3.7, 9.2, 4, 5));
    expect(valueNoise(3.7, 9.2, 5)).not.toBe(valueNoise(3.7, 9.2, 6));
  });

  it('is smooth: near points get near values', () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37;
      const y = i * 0.61;
      expect(Math.abs(valueNoise(x, y, 3) - valueNoise(x + 0.01, y, 3))).toBeLessThan(0.03);
    }
  });

  it('repeats exactly when given a period, so a texture tiles without a seam', () => {
    // A wall papered with a pattern that visibly restarts is worse than a
    // plain wall. Each octave doubles its period so the sum still closes.
    for (const [x, y] of [
      [0.3, 0.8],
      [2.9, 1.1],
      [5.5, 5.5],
    ] as const) {
      expect(valueNoise(x + 6, y, 11, 6)).toBeCloseTo(valueNoise(x, y, 11, 6), 12);
      expect(valueNoise(x, y + 6, 11, 6)).toBeCloseTo(valueNoise(x, y, 11, 6), 12);
      expect(fbm(x + 6, y + 6, 4, 11, 6)).toBeCloseTo(fbm(x, y, 4, 11, 6), 12);
    }
    // And does not, without one.
    expect(valueNoise(0.3 + 6, 0.8, 11)).not.toBeCloseTo(valueNoise(0.3, 0.8, 11), 6);
  });

  it('stays inside 0..1', () => {
    for (let i = 0; i < 2_000; i++) {
      const value = fbm(i * 0.173, i * 0.091, 5, 9);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
