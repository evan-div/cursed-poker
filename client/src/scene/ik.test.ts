import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { solveArm } from './ik.js';

/**
 * Arms that reach.
 *
 * The properties worth pinning: the bones keep their lengths, the hand lands
 * where it was sent, an unreachable target makes the arm fall short rather than
 * stretch, and the elbow breaks the same way every frame. That last one is the
 * difference between an arm and a windmill — without a pole the elbow is free to
 * spin about the shoulder-to-wrist axis and will happily pick a different answer
 * sixty times a second.
 */

const UPPER = 0.28;
const FOREARM = 0.26;
const POLE = new Vector3(0, -1, 0);

function solve(target: Vector3, shoulder = new Vector3(0, 1, 0)) {
  return { shoulder, ...solveArm(shoulder, target, UPPER, FOREARM, POLE) };
}

describe('solving an arm', () => {
  it('keeps both bones exactly the length they are', () => {
    for (const target of [
      new Vector3(0.2, 0.8, 0.2),
      new Vector3(-0.3, 0.9, 0.1),
      new Vector3(0, 1, 0.4),
      new Vector3(0.1, 1.2, 0.05),
    ]) {
      const { shoulder, elbow, wrist } = solve(target);
      expect(elbow.distanceTo(shoulder)).toBeCloseTo(UPPER, 6);
      expect(wrist.distanceTo(elbow)).toBeCloseTo(FOREARM, 6);
    }
  });

  it('puts the hand on the target when the target is in reach', () => {
    for (const target of [
      new Vector3(0.15, 0.85, 0.2),
      new Vector3(0, 0.75, 0.15),
      new Vector3(-0.2, 1.05, 0.25),
    ]) {
      const { wrist, strained } = solve(target);
      expect(strained).toBe(false);
      expect(wrist.distanceTo(target)).toBeLessThan(1e-6);
    }
  });

  it('falls short of something it cannot reach rather than stretching', () => {
    const target = new Vector3(0, 1, 4);
    const { shoulder, elbow, wrist, strained } = solve(target);

    expect(strained).toBe(true);
    expect(wrist.distanceTo(shoulder)).toBeLessThan(UPPER + FOREARM);
    // Still a real arm: the bones did not grow to cover the difference.
    expect(elbow.distanceTo(shoulder)).toBeCloseTo(UPPER, 6);
    expect(wrist.distanceTo(elbow)).toBeCloseTo(FOREARM, 6);
    // And it is pointing the right way.
    expect(wrist.z).toBeGreaterThan(shoulder.z);
  });

  it('never locks the arm dead straight', () => {
    const { shoulder, elbow, wrist } = solve(new Vector3(0, 1, UPPER + FOREARM));
    const straight = elbow.clone().sub(shoulder).normalize().dot(wrist.clone().sub(elbow).normalize());
    expect(straight).toBeLessThan(0.9999);
  });

  it('copes with a target on top of the shoulder', () => {
    const { shoulder, elbow, wrist } = solve(new Vector3(0, 1, 0));
    expect(Number.isFinite(elbow.x + elbow.y + elbow.z)).toBe(true);
    expect(elbow.distanceTo(shoulder)).toBeCloseTo(UPPER, 6);
    expect(wrist.distanceTo(elbow)).toBeCloseTo(FOREARM, 6);
  });

  it('breaks the elbow the way the pole says', () => {
    const target = new Vector3(0, 0.85, 0.3);
    const down = solveArm(new Vector3(0, 1, 0), target, UPPER, FOREARM, new Vector3(0, -1, 0));
    const up = solveArm(new Vector3(0, 1, 0), target, UPPER, FOREARM, new Vector3(0, 1, 0));
    expect(down.elbow.y).toBeLessThan(up.elbow.y);
  });

  it('gives the same answer for the same input, every time', () => {
    const target = new Vector3(0.1, 0.9, 0.3);
    const first = solve(target);
    for (let i = 0; i < 20; i++) {
      const again = solve(target);
      expect(again.elbow.distanceTo(first.elbow)).toBeLessThan(1e-12);
    }
  });

  it('survives a pole pointing straight down the arm', () => {
    const shoulder = new Vector3(0, 1, 0);
    const target = new Vector3(0, 0.5, 0);
    const solved = solveArm(shoulder, target, UPPER, FOREARM, new Vector3(0, -1, 0));
    expect(Number.isFinite(solved.elbow.length())).toBe(true);
    expect(solved.elbow.distanceTo(shoulder)).toBeCloseTo(UPPER, 6);
  });
});
