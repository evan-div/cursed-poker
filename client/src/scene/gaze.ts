import { GAZE_AWAY, type GazeTarget } from '@cursed/shared';
import {
  DEALER_STATION,
  POT_POSITION,
  RADIUS,
  TABLE,
  boardCardPosition,
  seatPoint,
  stationPoint,
  type Vec3,
} from './layout.js';

/**
 * What a player is looking at.
 *
 * The camera knows a direction; the table wants a *subject*. This turns one into
 * the other by asking which point of interest a look is closest to, and
 * answering "away" when it is close to none of them.
 *
 * It is pure maths over plain vectors, deliberately free of Three.js, because
 * the interesting cases — a player at seat 4 looking across the table at seat 1,
 * a player looking down at their own cards, a player staring into the dark —
 * should be checkable without a renderer.
 */

/**
 * The Dealer's face, such as it is: the hollow of the hood, which sits far above
 * where a seated player's head would be.
 */
const DEALER_FACE_HEIGHT = 1.68;

/** Half-angle within which a look counts as landing on something, in radians. */
const HIT_CONE = 0.28; // ~16 degrees

/**
 * Bias toward whoever is being looked at.
 *
 * People are what matter at a poker table, and a person is a much bigger thing
 * to look at than a card. Without this, glancing at an opponent's face reads as
 * "looking at the board" whenever they happen to sit behind it.
 */
const FACE_CONE = 0.42; // ~24 degrees

interface Candidate {
  target: GazeTarget;
  at: Vec3;
  cone: number;
}

/** Where a seated player's eyes are, for the purpose of being looked *at*. */
function faceOf(seatIndex: number): Vec3 {
  return seatPoint(seatIndex, RADIUS.body, 1.21);
}

/**
 * Everything at this table worth looking at, from `viewerSeat`'s point of view.
 *
 * The viewer's own cards and chips are separate targets from anybody else's,
 * because "they looked down at their hand" and "they looked at seat 3's stack"
 * are different pieces of information.
 */
export function gazeCandidates(viewerSeat: number | null, seats: readonly number[]): Candidate[] {
  const candidates: Candidate[] = [
    { target: { kind: 'DEALER' }, at: stationPoint(DEALER_STATION, RADIUS.body, DEALER_FACE_HEIGHT), cone: FACE_CONE },
    { target: { kind: 'BOARD' }, at: boardCentre(), cone: HIT_CONE },
    { target: { kind: 'POT' }, at: POT_POSITION, cone: HIT_CONE },
  ];

  if (viewerSeat !== null) {
    candidates.push(
      {
        target: { kind: 'OWN_CARDS' },
        at: seatPoint(viewerSeat, RADIUS.holeCards, TABLE.surfaceHeight),
        cone: HIT_CONE,
      },
      {
        target: { kind: 'OWN_CHIPS' },
        at: seatPoint(viewerSeat, RADIUS.chips, TABLE.surfaceHeight),
        cone: HIT_CONE,
      },
    );
  }

  for (const seatIndex of seats) {
    if (seatIndex === viewerSeat) continue;
    candidates.push({
      target: { kind: 'SEAT', seatIndex },
      at: faceOf(seatIndex),
      cone: FACE_CONE,
    });
  }

  return candidates;
}

/** The middle community card, which is the middle of the board. */
function boardCentre(): Vec3 {
  return boardCardPosition(2);
}

/**
 * Resolves a look into a target.
 *
 * `forward` need not be normalised. Ties go to the *narrower* cone, so a face
 * directly behind the board still reads as a face.
 */
export function resolveGaze(
  eye: Vec3,
  forward: Vec3,
  viewerSeat: number | null,
  seats: readonly number[],
): GazeTarget {
  const dir = normalise(forward);
  if (dir === null) return GAZE_AWAY;

  let best: { target: GazeTarget; score: number } | null = null;

  for (const candidate of gazeCandidates(viewerSeat, seats)) {
    const to = normalise({
      x: candidate.at.x - eye.x,
      y: candidate.at.y - eye.y,
      z: candidate.at.z - eye.z,
    });
    if (to === null) continue;

    const angle = Math.acos(clamp(dot(dir, to), -1, 1));
    if (angle > candidate.cone) continue;

    // Scored as a fraction of the target's own cone, so a small thing looked at
    // squarely beats a large one caught at its edge.
    const score = angle / candidate.cone;
    if (!best || score < best.score) best = { target: candidate.target, score };
  }

  return best?.target ?? GAZE_AWAY;
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalise(v: Vec3): Vec3 | null {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(length) || length < 1e-9) return null;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Where a target *is*, so a head can be turned toward one.
 *
 * The inverse direction to `resolveGaze`: given somebody else's replicated gaze,
 * this is the point their head should be pointing at. `OWN_CARDS` and
 * `OWN_CHIPS` resolve against the seat doing the looking, which is what makes
 * "they looked down at their hand" render correctly on their avatar.
 */
export function gazePoint(target: GazeTarget, ofSeat: number): Vec3 | null {
  switch (target.kind) {
    case 'DEALER':
      return stationPoint(DEALER_STATION, RADIUS.body, DEALER_FACE_HEIGHT);
    case 'SEAT':
      return faceOf(target.seatIndex);
    case 'BOARD':
      return boardCentre();
    case 'POT':
      return POT_POSITION;
    case 'OWN_CARDS':
      return seatPoint(ofSeat, RADIUS.holeCards, TABLE.surfaceHeight);
    case 'OWN_CHIPS':
      return seatPoint(ofSeat, RADIUS.chips, TABLE.surfaceHeight);
    case 'AWAY':
      return null;
  }
}
