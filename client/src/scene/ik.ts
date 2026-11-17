import { Vector3 } from 'three';

/**
 * Two-bone inverse kinematics: put a hand somewhere and let the elbow work it out.
 *
 * The arms were built once, from three fixed points, and never moved again. That
 * was fine while hands only rested on the felt, and useless the moment they had
 * to do anything — a hand that has to arrive at a card corner needs the elbow
 * solved for it, not authored.
 *
 * This is the classic circle-intersection solution rather than an iterative
 * solver: with exactly two bones there is a closed form, and it is both faster
 * and completely predictable. The elbow lies where two spheres meet — one of
 * upper-arm radius around the shoulder, one of forearm radius around the wrist —
 * and the `pole` picks which point on that circle, which is what stops elbows
 * inverting through torsos.
 *
 * Pure vector maths, so "can this arm reach that card?" is a question with a
 * test rather than a screenshot.
 */

export interface ArmSolution {
  /** Where to put the elbow. */
  elbow: Vector3;
  /**
   * Where the wrist actually ended up.
   *
   * The same as the target when it is in range, and pulled back onto the edge
   * of the arm's reach when it is not. An arm that stretches to hit a target it
   * cannot reach looks far worse than one that falls short.
   */
  wrist: Vector3;
  /** True when the target was out of reach and the wrist was clamped. */
  strained: boolean;
}

/** Keeps a solved arm just short of locked, so it never snaps rigid. */
const NEVER_QUITE_STRAIGHT = 0.995;

/** Scratch for the solve, so twelve arms a frame do not each make six vectors. */
const TO_TARGET = new Vector3();
const AXIS = new Vector3();
const SIDEWAYS = new Vector3();

/**
 * `into`, when given, is filled in and returned instead of a fresh solution.
 *
 * Every arm at the table is solved on every frame. Allocating the answer each
 * time was sixty-odd short-lived objects a frame for the collector to chase;
 * a caller that solves the same arm repeatedly should hand its last answer
 * back in.
 */
export function solveArm(
  shoulder: Vector3,
  target: Vector3,
  upperLength: number,
  forearmLength: number,
  pole: Vector3,
  into?: ArmSolution,
): ArmSolution {
  const toTarget = TO_TARGET.subVectors(target, shoulder);
  const distance = toTarget.length();

  const longest = (upperLength + forearmLength) * NEVER_QUITE_STRAIGHT;
  const shortest = Math.abs(upperLength - forearmLength) + 1e-4;
  const reach = Math.min(Math.max(distance, shortest), longest);
  const strained = reach !== distance;

  const axis = distance > 1e-6 ? AXIS.copy(toTarget).divideScalar(distance) : AXIS.set(0, 0, 1);
  const solution = into ?? { elbow: new Vector3(), wrist: new Vector3(), strained: false };
  solution.wrist.copy(shoulder).addScaledVector(axis, reach);

  // How far along the shoulder-to-wrist line the elbow sits, and how far off it.
  const along = (upperLength * upperLength - forearmLength * forearmLength + reach * reach) / (2 * reach);
  const out = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));

  // The pole decides which way the elbow breaks. Without it the joint is free
  // to rotate about the shoulder-wrist axis and picks a new answer every frame.
  const sideways = SIDEWAYS.copy(pole).addScaledVector(axis, -pole.dot(axis));
  if (sideways.lengthSq() < 1e-8) {
    // Pole parallel to the arm: any perpendicular will do, so take one.
    sideways.set(axis.y, -axis.x, 0);
    if (sideways.lengthSq() < 1e-8) sideways.set(0, axis.z, -axis.y);
  }
  sideways.normalize();

  solution.elbow.copy(shoulder).addScaledVector(axis, along).addScaledVector(sideways, out);
  solution.strained = strained;
  return solution;
}
