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
 * felt — but *how far* down matters more than it looks.
 *
 * The first version aimed at the middle of the table, which put a player's own
 * two cards at the very bottom edge of the screen: every hand began by dragging
 * the view down a hundred pixels to find your own hand, and if you did not know
 * to do that, the answer to "what have I got?" was a sliver of card at the
 * bottom of the frame. So the rest aims most of the way toward your own cards
 * instead. The board is still comfortably in view; opponents' faces are a
 * deliberate look up, which is the right way round — raising your eyes to
 * somebody is the thing worth noticing.
 */
const REST_AIM_TOWARD_OWN_CARDS = 0.68;

const REST_AIM_DISTANCE =
  RADIUS.eye - REST_AIM_TOWARD_OWN_CARDS * (RADIUS.eye - RADIUS.holeCards);

export const REST_PITCH = -Math.atan2(EYE_HEIGHT - TABLE.surfaceHeight, REST_AIM_DISTANCE);

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
  stackSpacing: 0.043,
} as const;

/**
 * What each colour of chip is worth, in quarters of a big blind.
 *
 * Relative to the blinds rather than in chips, so a stack looks the same at
 * every level: a hundred big blinds is the same pile whether the big blind is
 * a hundred or a thousand. That was already true when a pile was simply a count;
 * it stays true now that the colours mean something.
 */
export const CHIP_VALUES = [1, 4, 20, 100, 400] as const;

/**
 * How many extra groups of small chips a stack keeps instead of colouring up.
 *
 * Nobody sits behind the fewest chips that could make their total. A real stack
 * has change in it, and the change is most of its bulk — which matters here,
 * because the size of a pile is the first thing anybody reads across a table.
 */
const CHIP_CHANGE = [2, 3, 3, 2] as const;

/**
 * Breaks an amount into chips, cheapest colour first.
 *
 * A pile is still a *feeling*, not a ledger — the authoritative number is on the
 * nameplate — but it is now an honest one. Ten big blinds is a short stack of
 * small chips; three hundred is the same change with a tower of big ones behind
 * it. The old pile was a count capped at ninety, so everybody with more than
 * twenty big blinds had exactly the same stack and the chip leader looked like
 * the player about to bust.
 */
export function chipBreakdown(amount: number, bigBlind: number): number[] {
  const counts = CHIP_VALUES.map(() => 0);
  if (amount <= 0 || bigBlind <= 0) return counts;

  // In quarter blinds, and never nothing: one chip is still a chip.
  let left = Math.max(1, Math.round((amount * 4) / bigBlind));
  const last = CHIP_VALUES.length - 1;
  for (let i = 0; i < last; i++) {
    const value = CHIP_VALUES[i]!;
    const next = CHIP_VALUES[i + 1]!;
    // Enough of this colour that the rest divides into the next one up, plus
    // some change kept back.
    const needed = (left % next) / value;
    const spare = Math.min(Math.floor(left / next), CHIP_CHANGE[i]!) * (next / value);
    counts[i] = needed + spare;
    left -= counts[i]! * value;
  }
  counts[last] = left / CHIP_VALUES[last]!;
  return counts;
}

/** One chip, placed: where it is, which colour, and how it happens to be turned. */
export interface PlacedChip extends Vec3 {
  /** Index into `CHIP_VALUES`. */
  denomination: number;
  /** Radians about the vertical. Nobody stacks chips with the spots lined up. */
  turn: number;
}

/** A repeatable number in [0, 1) for a chip's place in a pile. */
function jitter(a: number, b: number): number {
  let h = Math.imul(a + 1, 0x27d4eb2d) ^ Math.imul(b + 7, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4_294_967_296;
}

/**
 * Lays chips out as a player keeps them: stacks by colour, big ones at the back.
 *
 * Two rows, staggered, so six or seven stacks take up the room of four. Offsets
 * are from the pile's own position, with +x to the owner's right and +z toward
 * them.
 */
export function chipStacks(counts: readonly number[], perStack: number = CHIP.perStack, most = 120): PlacedChip[] {
  // A stack per colour, split when it gets too tall, most valuable first.
  const stacks: { denomination: number; height: number }[] = [];
  let budget = most;
  for (let denomination = counts.length - 1; denomination >= 0; denomination--) {
    let left = Math.min(counts[denomination] ?? 0, budget);
    budget -= left;
    while (left > 0) {
      const height = Math.min(left, perStack);
      stacks.push({ denomination, height });
      left -= height;
    }
  }

  const out: PlacedChip[] = [];
  const columns = Math.ceil(stacks.length / 2);
  stacks.forEach((stack, index) => {
    // Back row first, then the front row tucked into the gaps.
    const front = index >= columns;
    const column = front ? index - columns : index;
    const inRow = front ? stacks.length - columns : columns;
    // Each row is centred. A front row one shorter than the back already sits
    // in the gaps; one the same length is shifted half a stack to get there.
    const x =
      (column - (inRow - 1) / 2) * CHIP.stackSpacing + (front && inRow === columns ? CHIP.stackSpacing / 2 : 0);
    const z = front ? CHIP.stackSpacing * 0.43 : -CHIP.stackSpacing * 0.43;
    for (let level = 0; level < stack.height; level++) {
      out.push({
        x: x + (jitter(index, level) - 0.5) * 0.0016,
        y: CHIP.height * (level + 0.5),
        z: z + (jitter(level, index) - 0.5) * 0.0016,
        denomination: stack.denomination,
        turn: jitter(index * 31 + level, 5) * Math.PI * 2,
      });
    }
  });
  return out;
}

/**
 * Lays chips out as a pot: pushed together, not stacked.
 *
 * Little piles a few chips high, spiralling out from the middle, so a pot that
 * has been bet into four times is visibly a heap and one with the blinds in it
 * is a few chips on the cloth.
 */
export function chipHeap(counts: readonly number[], most = 120): PlacedChip[] {
  const chips: number[] = [];
  for (let denomination = counts.length - 1; denomination >= 0; denomination--) {
    for (let i = 0; i < (counts[denomination] ?? 0) && chips.length < most; i++) chips.push(denomination);
  }

  const out: PlacedChip[] = [];
  let pile = 0;
  let level = 0;
  let tall = 4;
  for (const [index, denomination] of chips.entries()) {
    if (level >= tall) {
      pile++;
      level = 0;
      tall = 2 + Math.floor(jitter(pile, 11) * 4);
    }
    // The golden angle: every pile lands in the widest gap left by the others.
    const angle = pile * 2.399963;
    const radius = CHIP.radius * 1.55 * Math.sqrt(pile);
    out.push({
      x: Math.cos(angle) * radius + (jitter(index, 13) - 0.5) * 0.006,
      y: CHIP.height * (level + 0.5),
      z: Math.sin(angle) * radius + (jitter(index, 17) - 0.5) * 0.006,
      denomination,
      turn: jitter(index, 19) * Math.PI * 2,
    });
    level++;
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
