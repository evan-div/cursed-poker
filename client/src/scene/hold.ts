import { HAND_LIFT } from '@cursed/shared';
import { CARD, RADIUS, seatPoint, seatStation, stationAngle, type Vec3 } from './layout.js';
import { PEEL_SPAN } from './peel.js';

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
 * Where the fingertips of the peeling hand belong.
 *
 * The near-right corner of the right-hand card: the corner the fold runs from,
 * which is the one a finger would actually be on. As the cards come off the
 * table the contact point rises with them, because the hand is what is carrying
 * them.
 */
export function peelContact(seatIndex: number, exposure: number, lift: number): Vec3 {
  const card = heldCard(seatIndex, 1, lift);
  const outward = outwardFrom(seatIndex);
  const right = rightFrom(seatIndex);

  // The near edge, on the leading side, and a little in from both so the finger
  // sits on the card rather than off its corner.
  const towardNear = (CARD.height / 2) * PEEL_SPAN * 0.75;
  const towardRight = CARD.width * 0.3;

  // A curled corner lifts off the felt; the finger on it rises too.
  const curl = clamp01(exposure) * CARD.height * 0.22;

  return {
    x: card.position.x + outward.x * towardNear + right.x * towardRight,
    y: card.position.y + curl,
    z: card.position.z + outward.z * towardNear + right.z * towardRight,
  };
}

/**
 * Where the off hand goes when the cards come up.
 *
 * Cupped against the far side of the pair, the way anybody who has ever been
 * dealt a hand shields it. It only matters once the cards have left the table —
 * a hand hovering over cards lying flat on the felt looks like a threat.
 */
export function shieldContact(seatIndex: number, lift: number): Vec3 {
  const card = heldCard(seatIndex, 0, lift);
  const outward = outwardFrom(seatIndex);
  const right = rightFrom(seatIndex);
  const across = CARD.width * 0.75;

  return {
    x: card.position.x - right.x * across + outward.x * CARD.height * 0.1,
    y: card.position.y,
    z: card.position.z - right.z * across + outward.z * CARD.height * 0.1,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
