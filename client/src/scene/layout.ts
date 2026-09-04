import { SEAT_COUNT } from '@cursed/shared';

/**
 * Where everything sits, in metres.
 *
 * Pure maths, deliberately separated from anything that touches Three.js: the
 * table is a ring of stations and every renderer — avatars, cards, chips, the
 * camera — derives its placement from the same numbers here. Nothing is allowed
 * to guess a position of its own, because a card that does not line up with the
 * hand holding it is the kind of bug that survives to shipping.
 *
 * The table is round and seats seven. One station belongs to the Dealer; the
 * other six are the players. A ring rather than a casino oval is a deliberate
 * choice: this is a séance, and the shape should say so before anything else
 * does.
 */

export const TABLE = {
  /** Radius of the playing surface. */
  feltRadius: 0.66,
  /** Outer radius including the padded rail. */
  railRadius: 0.76,
  /** Height of the playing surface above the floor. */
  surfaceHeight: 0.76,
  railHeight: 0.055,
} as const;

/** Seven stations: index 0 is the Dealer, 1..6 are player seats 0..5. */
export const STATION_COUNT = SEAT_COUNT + 1;
export const DEALER_STATION = 0;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The angle of a station, measured clockwise from the far side of the table.
 * The Dealer sits at the far side (angle 0) so that a player looking across the
 * table is looking at him.
 */
export function stationAngle(station: number): number {
  return (station / STATION_COUNT) * Math.PI * 2;
}

export function seatStation(seatIndex: number): number {
  return seatIndex + 1;
}

export function seatAngle(seatIndex: number): number {
  return stationAngle(seatStation(seatIndex));
}

/** A point on the table plane at `radius` from the centre, for `station`. */
export function stationPoint(station: number, radius: number, height: number = TABLE.surfaceHeight): Vec3 {
  const angle = stationAngle(station);
  return { x: Math.sin(angle) * radius, y: height, z: -Math.cos(angle) * radius };
}

export function seatPoint(seatIndex: number, radius: number, height: number = TABLE.surfaceHeight): Vec3 {
  return stationPoint(seatStation(seatIndex), radius, height);
}

// ---------------------------------------------------------------------------
// Where each kind of thing lives
// ---------------------------------------------------------------------------

/** Distance from the centre at which a seat's own belongings sit. */
export const RADIUS = {
  /** A player's two hole cards, right at the rail in front of them. */
  holeCards: 0.55,
  /** Their chip stacks, a little inside the cards and off to one side. */
  chips: 0.47,
  /** Chips they have pushed forward this street. */
  bet: 0.31,
  /** Where a body sits: chest just clear of the rail. */
  body: 1.02,
  /** Where the eyes are. Directly above the chest, as heads tend to be. */
  eye: 1.02,
} as const;

/** Eye height above the floor for a seated player. */
export const EYE_HEIGHT = 1.22;

/**
 * The pitch a player's head rests at when they sit down.
 *
 * Looking dead level from a chair points you across the table into the dark,
 * which is atmospheric and useless. A real player's resting gaze is down on the
 * felt, and this is the angle from the eye to the middle of the table.
 */
export const REST_PITCH = -Math.atan2(EYE_HEIGHT - TABLE.surfaceHeight, RADIUS.eye);

/** The five community cards, laid left to right across the middle. */
export const BOARD = {
  cardSpacing: 0.075,
  /** Pushed slightly toward the Dealer, the way a real dealer lays them out. */
  offsetZ: -0.06,
} as const;

export function boardCardPosition(index: number): Vec3 {
  const spread = (index - 2) * BOARD.cardSpacing;
  return { x: spread, y: TABLE.surfaceHeight, z: BOARD.offsetZ };
}

/** The pot sits between the board and the Dealer. */
export const POT_POSITION: Vec3 = { x: 0, y: TABLE.surfaceHeight, z: -0.2 };

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export interface SeatedView {
  position: Vec3;
  /**
   * Yaw for a Three.js camera, in radians, that points it at the middle of the
   * table. Cameras look down their own -Z, so a camera with `rotation.y = yaw`
   * looks along `(-sin yaw, 0, -cos yaw)` — which is *not* the same convention
   * as `stationPoint`, and mixing the two seats everyone facing the wrong way
   * on four of the six chairs.
   */
  yaw: number;
}

/**
 * Where a player's eyes are, and which way they face when they sit down.
 *
 * A viewer with no seat (a spectator, or somebody still in the lobby) is put in
 * the Dealer's place, looking across the table.
 */
export function seatedView(seatIndex: number | null): SeatedView {
  const station = seatIndex === null ? DEALER_STATION : seatStation(seatIndex);
  const angle = stationAngle(station);
  return {
    position: {
      x: Math.sin(angle) * RADIUS.eye,
      y: EYE_HEIGHT,
      z: -Math.cos(angle) * RADIUS.eye,
    },
    // Facing the centre from `angle` means looking along (-sin a, 0, cos a),
    // which for a camera's -Z forward axis is a yaw of PI - a.
    yaw: Math.PI - angle,
  };
}

/** How far a seated player may turn their head before their body would have to. */
export const LOOK_LIMITS = {
  yaw: (100 * Math.PI) / 180,
  pitchDown: (-70 * Math.PI) / 180,
  pitchUp: (35 * Math.PI) / 180,
} as const;

/**
 * Yaw for a body (or any object whose forward axis is its own +Z) placed at a
 * station and facing the middle. The opposite sign to a camera's, for the same
 * reason.
 */
export function facingCentreYaw(station: number): number {
  return -stationAngle(station);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export const CHIP = {
  radius: 0.0195,
  height: 0.0034,
  /** Chips are stacked this high before a new stack is started beside it. */
  perStack: 20,
  /** Gap between the centres of neighbouring stacks. */
  stackSpacing: 0.045,
} as const;

/**
 * How many chips to show for an amount.
 *
 * A stack is a *feeling*, not an accounting record: the authoritative number is
 * the one on the HUD. Showing one chip per unit would be thousands of meshes,
 * so a chip is worth a fixed fraction of a big blind and the pile is capped at
 * something a person could plausibly have in front of them.
 */
export function chipCountFor(amount: number, bigBlind: number, max = 120): number {
  if (amount <= 0 || bigBlind <= 0) return 0;
  const perChip = bigBlind / 4;
  return clamp(Math.round(amount / perChip), 1, max);
}

/** Lays `count` chips into stacks, returning each chip's offset from the pile. */
export function chipPile(count: number): Vec3[] {
  const out: Vec3[] = [];
  const stacks = Math.ceil(count / CHIP.perStack);
  for (let i = 0; i < count; i++) {
    const stack = Math.floor(i / CHIP.perStack);
    const height = i % CHIP.perStack;
    // Centre the row of stacks on the pile's own position.
    const x = (stack - (stacks - 1) / 2) * CHIP.stackSpacing;
    out.push({ x, y: CHIP.height * (height + 0.5), z: 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** A real poker card, in metres. */
export const CARD = {
  width: 0.0635,
  height: 0.0889,
  thickness: 0.0009,
} as const;
