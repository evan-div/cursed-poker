import { describe, expect, it } from 'vitest';
import { GOVERNOR, Governor, pinnedDetail } from './quality.js';

/** Feeds a governor `count` frames of `ms` each; true if any of them demoted it. */
function run(governor: Governor, count: number, ms: number): boolean {
  let demoted = false;
  for (let i = 0; i < count; i++) demoted = governor.frame(ms) || demoted;
  return demoted;
}

describe('the quality governor', () => {
  it('leaves a machine that keeps up alone', () => {
    const governor = new Governor();
    // Ten minutes at sixty frames a second.
    expect(run(governor, 36_000, 16.7)).toBe(false);
  });

  it('steps a machine that cannot keep up down, once', () => {
    const governor = new Governor();
    // Twenty frames a second, steadily.
    let demotions = 0;
    for (let i = 0; i < 2_000; i++) if (governor.frame(50)) demotions++;
    expect(demotions).toBe(1);
  });

  it('does not count the frames spent starting up', () => {
    const governor = new Governor();
    // Shaders compiling: dreadful frames, and not the machine's fault.
    expect(run(governor, GOVERNOR.warmupFrames, 400)).toBe(false);
    expect(run(governor, 10_000, 16.7)).toBe(false);
  });

  it('forgives a bad second', () => {
    const governor = new Governor();
    run(governor, 600, 16.7);
    // Half a second of stutter, then fine again, over and over.
    for (let i = 0; i < 30; i++) {
      expect(run(governor, 10, 50)).toBe(false);
      expect(run(governor, 600, 16.7)).toBe(false);
    }
  });

  it('is not fooled by a tab that was hidden', () => {
    const governor = new Governor();
    run(governor, 600, 16.7);
    // One frame, thirty seconds long: the player looked at something else.
    expect(governor.frame(30_000)).toBe(false);
    expect(run(governor, 600, 16.7)).toBe(false);
  });

  it('gives up on a machine within a few seconds, not a few minutes', () => {
    const governor = new Governor();
    run(governor, GOVERNOR.warmupFrames, 16.7);
    let spent = 0;
    while (!governor.frame(60) && spent < 60_000) spent += 60;
    expect(spent).toBeLessThan(6_000);
  });
});

describe('asking for a tier by name', () => {
  const nothing = { getItem: () => null };

  it('reads it from the address', () => {
    expect(pinnedDetail('?quality=low', nothing)).toBe('low');
    expect(pinnedDetail('?foo=1&quality=high', nothing)).toBe('high');
  });

  it('falls back to what was remembered', () => {
    expect(pinnedDetail('', { getItem: () => 'low' })).toBe('low');
    // The address wins: it is the more recent thing somebody said.
    expect(pinnedDetail('?quality=high', { getItem: () => 'low' })).toBe('high');
  });

  it('ignores anything that is not a tier', () => {
    expect(pinnedDetail('?quality=ultra', nothing)).toBeNull();
    expect(pinnedDetail('', { getItem: () => 'potato' })).toBeNull();
    expect(pinnedDetail('', nothing)).toBeNull();
  });
});
