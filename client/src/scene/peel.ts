import { PEEK } from '@cursed/shared';
import { CARD } from './layout.js';

/**
 * Bending a card off the felt.
 *
 * Hole cards lie **face down**. To read one you press a finger on the near
 * corner and curl it up until you can see the underside — the card bends, the
 * far half never leaves the table, and the corner that leads is the one under
 * your finger. That is the motion this file describes.
 *
 * It matters that it is a bend and not a tilt. A rigid card propped against the
 * felt is a different physical claim: it says the card left the table, which is
 * the one thing a careful player never lets happen. The bend keeps the far edge
 * pinned, which is what makes a peek look furtive rather than theatrical.
 *
 * Pure maths over local card coordinates, so the feel is testable without a
 * renderer:
 *
 *   x  across the card, -w/2 (one edge) .. +w/2 (the other)
 *   y  along it, -h/2 at the NEAR edge (the player's side) .. +h/2 at the far
 *   z  thickness; +z is up once the card is lying flat
 */

/** Fraction of the card, measured from the near edge, that curls. */
export const PEEL_SPAN = 0.62;

/**
 * How much more the leading corner curls than the trailing one.
 *
 * A card lifted evenly along its edge is a drawbridge. A real peek pivots
 * around one fingertip, so one corner comes up first and the fold runs
 * diagonally across the card.
 */
export const CORNER_LEAD = 0.42;

export interface PeeledPoint {
  y: number;
  z: number;
}

/**
 * Total bend at the leading corner, in radians, for a given exposure.
 *
 * Past a right angle at full exposure: the underside has to come past vertical
 * before it faces the player rather than the ceiling.
 */
export function peelAngle(exposure: number): number {
  const e = clamp01(exposure);
  // Eased, so a twitch is not a tell and the last part of the pull opens it.
  return PEEK.maxLift * e * e * (3 - 2 * e);
}

/**
 * Where a point on the card ends up once it is peeled.
 *
 * The card is straight from the far edge to the hinge and a circular arc from
 * the hinge to the near edge, which is what a bent piece of card actually does:
 * it does not crease, it curves.
 */
export function peelPoint(x: number, y: number, z: number, bend: number): PeeledPoint {
  const half = CARD.height / 2;
  const length = PEEL_SPAN * CARD.height;
  const hinge = -half + length;

  // The far part of the card never moves. This is the whole point of a peel.
  if (y >= hinge) return { y, z };

  // The corner under the finger leads; the far corner trails.
  const across = (x + CARD.width / 2) / CARD.width;
  const angle = bend * (1 - CORNER_LEAD + CORNER_LEAD * across);
  if (!(angle > 1e-4)) return { y, z };

  const radius = length / angle;
  const along = hinge - y; // 0 at the hinge, `length` at the near edge
  const theta = angle * (along / length);

  return {
    y: hinge - radius * Math.sin(theta),
    z: z + radius * (1 - Math.cos(theta)),
  };
}

/**
 * The angle the card's surface has turned through at the near edge.
 *
 * This is the number that decides whether the owner can actually read anything:
 * below a right angle the underside still faces the felt, above it the face has
 * come round toward the person holding it.
 */
export function nearEdgeAngle(exposure: number): number {
  return peelAngle(exposure) * (1 - CORNER_LEAD + CORNER_LEAD * 1);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
