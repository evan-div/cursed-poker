import { HAND_LIFT } from '@cursed/shared';
import { CARD, RADIUS, seatPoint, seatStation, stationAngle, type Vec3 } from './layout.js';
import { PEEL_SPAN, peelAngle, peelPoint } from './peel.js';

/**
 * Where a hand is holding a pair of cards.
 *
 * One set of numbers, used twice: the card renderer puts the cards here, and the
 * avatar puts its hand here. They have to agree exactly or the cards float and
 * the hand grasps at nothing, so neither of them owns the answer — this does.
 *
 * Pure, and free of Three.js, so "does the hand end up on the card?" is a
 * question with a test.
 */

/** Which way "away from the middle of the table" points, for a seat. */
export function outwardFrom(seatIndex: number): Vec3 {
  const angle = stationAngle(seatStation(seatIndex));
  return { x: Math.sin(angle), y: 0, z: -Math.cos(angle) };
}

/**
 * Which way the player's right hand is, for a seat.
 *
 * A person facing the middle of the table has the table's clockwise direction on
 * their right. The leading corner of a peel is on this side, which is why the
 * right hand does the peeling.
 */
export function rightFrom(seatIndex: number): Vec3 {
  const angle = stationAngle(seatStation(seatIndex));
  return { x: -Math.cos(angle), y: 0, z: -Math.sin(angle) };
}

/** Where a seat's hole cards lie when nobody is touching them. */
export function holeCardRest(seatIndex: number, cardIndex: number): Vec3 {
  const centre = seatPoint(seatIndex, RADIUS.holeCards);
  const right = rightFrom(seatIndex);
  const offset = (cardIndex - 0.5) * (CARD.width + 0.006);
  return {
    x: centre.x + right.x * offset,
    y: centre.y + CARD.thickness / 2 + 0.001,
    z: centre.z + right.z * offset,
  };
}

export interface HeldCard {
  position: Vec3;
  /** Rotation about the card's own long axis; -PI/2 is flat on the felt. */
  tilt: number;
  /** A slight fan, so two cards in one hand are never square to each other. */
  roll: number;
}

/** Eased, so cards come off the table with weight rather than snapping up. */
export function raiseAmount(lift: number): number {
  const l = clamp01(lift);
  return l * l * (3 - 2 * l);
}

/**
 * Where a card sits, given how far it has been picked up off the table.
 *
 * At zero it is flat on the felt where it was dealt. At one it is up in front of
 * its owner's face, tipped back toward them and fanned slightly against its
 * partner.
 */
export function heldCard(seatIndex: number, cardIndex: number, lift: number): HeldCard {
  const rest = holeCardRest(seatIndex, cardIndex);
  const raised = raiseAmount(lift);
  const outward = outwardFrom(seatIndex);

  return {
    position: {
      x: rest.x + outward.x * HAND_LIFT.reach * raised,
      y: rest.y + HAND_LIFT.height * raised,
      z: rest.z + outward.z * HAND_LIFT.reach * raised,
    },
    tilt: -Math.PI / 2 - HAND_LIFT.tilt * raised,
    roll: (cardIndex === 0 ? 1 : -1) * 0.09 * raised,
  };
}

/**
 * How far a card is bent, given its seat's exposure and how far it has come off
 * the table.
 *
 * Two separate things, and the second one *undoes* the first. A bend is a peek:
 * the far half of the card stays pinned to the felt and the near corner curls up
 * under a fingertip, because that is the only way to read a card you are not
 * willing to lift. Once the pair is off the table there is nothing left to bend
 * against and nothing left to hide behind, so the curl relaxes and the cards go
 * flat in the hand — which is what a player holding their hand up is actually
 * holding. Carrying the curl up with them left the raised pair looking crushed,
 * as though somebody were wringing them.
 *
 * The near card leads, which is how a person actually does it: a small peek
 * shows one rank rather than half of each.
 */
export function cardBend(cardIndex: number, exposure: number, lift = 0): number {
  const lead = cardIndex === 0 ? 1.12 : 0.88;
  return peelAngle(clamp01(exposure) * lead * (1 - raiseAmount(lift)));
}

/**
 * Turns a direction in a card's own coordinates into a world direction.
 *
 * A card's local axes, and where they end up:
 *
 *   +x  across the card, toward the player's right
 *   +y  along it, toward the edge *furthest* from the player
 *   +z  out of the top face — which, for a hole card, is its back
 *
 * The mesh is rotated yaw-then-tilt-then-roll (Three's `YXZ`), and the yaw is
 * always the one that makes the card read right way up to its owner, so the
 * yawed frame is exactly the seat's own: `right`, world up, and `outward`.
 *
 * Worth knowing before reading anything below about gripping "the bottom": a
 * card has to rotate *past* vertical for its printed underside to come round and
 * face its owner, so the edge nearest the player ends up at the **top** of a
 * raised pair and the far edge is the one down in the hand. There is no
 * orientation where the face is toward the player and the near edge is at the
 * bottom — turning the card over is what swaps them.
 */
export function fromCardSpace(seatIndex: number, local: Vec3, tilt: number, roll: number): Vec3 {
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const x = local.x * cr - local.y * sr;
  const y = local.x * sr + local.y * cr;

  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const up = y * ct - local.z * st;
  const out = y * st + local.z * ct;

  const right = rightFrom(seatIndex);
  const outward = outwardFrom(seatIndex);
  return {
    x: x * right.x + out * outward.x,
    y: up,
    z: x * right.z + out * outward.z,
  };
}

/**
 * A point on a card's surface, in world space.
 *
 * `local` is in card coordinates, and it is put through the peel first, so a
 * point on the curled part of the card rides the curl instead of hovering over
 * where the card used to be. This is how the hand knows to follow the fold.
 */
export function cardSurfacePoint(
  seatIndex: number,
  cardIndex: number,
  lift: number,
  local: Vec3,
  bend = 0,
): Vec3 {
  const held = heldCard(seatIndex, cardIndex, lift);
  const bent = peelPoint(local.x, local.y, local.z, bend);
  const offset = fromCardSpace(seatIndex, { x: local.x, y: bent.y, z: bent.z }, held.tilt, held.roll);
  return {
    x: held.position.x + offset.x,
    y: held.position.y + offset.y,
    z: held.position.z + offset.z,
  };
}

/**
 * Where the hand takes hold, in fractions of a card's half-width and
 * half-height, so ±1 is an edge.
 */
const GRIP = {
  /** Peeling: on the near-right corner, in far enough to be on the card. */
  peel: { across: 0.6, along: -PEEL_SPAN * 0.75 },
  /** Raised: the low edge of the pair — see `fromCardSpace` for which one. */
  raised: { across: 0.28, along: 0.9 },
} as const;

export interface Grip {
  /** Where the cards are pinched: thumb on one face, fingers on the other. */
  at: Vec3;
  /** Out of the grip along the cards, which is the way the fingers point. */
  along: Vec3;
  /** Out of the back of the hand. */
  up: Vec3;
  /**
   * How far the hand has turned from flat on the felt toward that, 0..1.
   *
   * At zero the hand's frame is the seat's own resting one — palm down, fingers
   * pointing across the table — so a caller only ever needs the raised frame and
   * this number.
   */
  raise: number;
}

/**
 * Where the hand is on the cards, and which way round it is.
 *
 * Two poses, blended by how far the pair has come off the table.
 *
 * **Peeling.** The cards are on the felt. The thumb is pressed on the near-right
 * corner — the one the fold runs from — holding it down while the corner curls
 * up under it. The hand is flat, above the card, palm down.
 *
 * **Raised.** The pair is up in front of the player, pinched at its low edge
 * with the fingers behind and the thumb across the front, cards standing up out
 * of the grip. This is the pose that was wrong before: the contact point was
 * computed on the card's *flat* frame and so stayed level with the middle of a
 * card that had since rotated to near-vertical, which put the fingers under the
 * belly of the pair and left them looking balanced there rather than held.
 * Anchoring the grip to a point on the card's own surface is what fixes it, and
 * is why `fromCardSpace` exists.
 */
export function gripPose(seatIndex: number, exposure: number, lift: number): Grip {
  const raise = raiseAmount(lift);

  const peeling = cardSurfacePoint(
    seatIndex,
    1,
    lift,
    {
      x: (GRIP.peel.across * CARD.width) / 2,
      y: (GRIP.peel.along * CARD.height) / 2,
      z: CARD.thickness / 2,
    },
    cardBend(1, exposure, lift),
  );

  // Raised, the hand is under *both* cards rather than on one of them, so the
  // grip is the middle of the pair's low edge.
  const edge = {
    x: (GRIP.raised.across * CARD.width) / 2,
    y: (GRIP.raised.along * CARD.height) / 2,
    z: 0,
  };
  const raisedAt = midpoint(
    cardSurfacePoint(seatIndex, 0, lift, edge),
    cardSurfacePoint(seatIndex, 1, lift, edge),
  );

  return {
    at: mix(peeling, raisedAt, raise),
    ...raisedFrame(seatIndex, lift),
    raise,
  };
}

/**
 * Where the off hand goes when the cards come up.
 *
 * Cupped against the outer side of the pair, low, the way anybody who has ever
 * been dealt a hand shields it — and turned the same way round as the hand
 * holding them, because it is doing the same job from the other side.
 *
 * Beside and *below*, not across. A shield brought up level with the faces is a
 * second set of fingers standing between a player and the only thing they
 * picked the cards up to look at. It only matters once the cards have left the
 * table at all: a hand hovering over cards lying flat on the felt looks like a
 * threat.
 */
export function shieldPose(seatIndex: number, lift: number): Grip {
  const raise = raiseAmount(lift);
  const frame = raisedFrame(seatIndex, lift);
  const edge = cardSurfacePoint(seatIndex, 0, lift, {
    x: -CARD.width * 0.85,
    y: (GRIP.raised.along * CARD.height) / 2,
    z: 0,
  });

  return { at: edge, ...frame, raise };
}

/**
 * The hand's frame once the pair is up: fingers along the cards, back of the
 * hand against their backs.
 *
 * Both come straight off the card's own axes, which is the point — a hand whose
 * orientation is authored separately from the thing it is holding drifts off it
 * the moment either is retuned.
 *
 * Hold two cards up and look at them. Your palm and your fingers are flat
 * against the backs; the only thing on the printed side is your thumb, reaching
 * round from underneath. So the hand's own back — the side its fingers fold away
 * from — faces the same way the cards' backs do, and everything on that side of
 * the hand stays out of its owner's view. Getting this the other way round puts
 * four fingers across the faces and leaves the thumb waving behind, which is a
 * hand covering up the one thing its owner picked the cards up to see.
 */
function raisedFrame(seatIndex: number, lift: number): { along: Vec3; up: Vec3 } {
  const held = heldCard(seatIndex, 1, lift);
  return {
    // Out of the low edge toward the far one: local -y, which is up.
    along: fromCardSpace(seatIndex, { x: 0, y: -1, z: 0 }, held.tilt, held.roll),
    // Local +z: out of the card's back, away from the person reading it.
    up: fromCardSpace(seatIndex, { x: 0, y: 0, z: 1 }, held.tilt, held.roll),
  };
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function mix(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
