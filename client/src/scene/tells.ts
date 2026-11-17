import { CALM, type PresenceFrame, type SeatTells, type SweatLevel } from '@cursed/shared';

/**
 * What everybody else's body is giving away, made visible.
 *
 * The server sends three words per seat — how hard their hands are shaking,
 * how hard they are breathing, how wet their face is — already rounded to a
 * coarse grid. This turns them into movement: hands that will not stay still on
 * the felt, a pair of cards that trembles when it is held up, shoulders that
 * rise and fall faster than they should, skin that has started to shine.
 *
 * ## The rule
 *
 * **The motion of a seat is a function of that seat's broadcast tells and of
 * nothing else.** Not its stack, not its cards, not anything this client knows
 * that the server did not put in the presence frame, and not any other seat's
 * tells. The tests pin this by feeding two tables different everything-else
 * and requiring identical motion.
 *
 * It matters because the tells were designed to be safe at the resolution they
 * are broadcast at — eight steps, see `STRESS.tellSteps`. A renderer that
 * reached for more (a heart rate it computed itself, a hand-strength guess, a
 * smoothing that differenced two seats) would be adding resolution the server
 * deliberately took away. Easing *between* two broadcast values adds none: it
 * only hides the staircase.
 *
 * The noise that drives the shaking is seeded from the seat number and runs on
 * this client's own clock. It carries no information at all, which is the
 * point — it is texture over a signal, never a signal of its own.
 */

/** How the tells read on a body. Tuned from across a table, not up close. */
export const TELL_MOTION = {
  /** Seconds for an eased tell to catch up with a new broadcast value. */
  easeSeconds: 0.6,
  /** Sweat is slower: a face does not dry, or soak, in a second. */
  sweatEaseSeconds: 3.5,
  /** Peak hand displacement at full tremor, in metres. Visible across the felt. */
  handMetres: 0.0065,
  /** Raised cards are a lever on a shaking hand. */
  heldCardGain: 1.5,
  /** Peak roll of a raised pair at full tremor, in radians. */
  heldCardRoll: 0.035,
  /** Peak head tremor, in radians. Small: heads are heavy. */
  headRadians: 0.012,
  /** Breaths per minute, at rest and at full breathing tell. */
  breathsPerMinute: { calm: 12, panic: 34 },
  /** How far shoulders rise on a breath, in metres. Never zero: people breathe. */
  breathMetres: { calm: 0.0035, panic: 0.016 },
} as const;

/** Sweat as a continuous amount, so it can ease. */
const SWEAT_AMOUNT: Record<SweatLevel, number> = { DRY: 0, DAMP: 0.5, SOAKED: 1 };

/** One seat's tells, eased, plus the movement they produce this frame. */
export interface TellMotion {
  /** Eased tells, 0..1 each. */
  tremor: number;
  breathing: number;
  sweat: number;
  /** Where each hand is pushed this frame, in world metres. [right, left]. */
  hands: [Offset, Offset];
  /** Extra movement for a raised pair: a lever on the right hand. */
  heldCards: { offset: Offset; roll: number };
  /** Head tremor on top of where it is looking, in radians. */
  head: { yaw: number; pitch: number };
  /** Shoulders' rise on the current breath, in metres. */
  breath: number;
}

export interface Offset {
  x: number;
  y: number;
  z: number;
}

const ZERO: Offset = { x: 0, y: 0, z: 0 };

/** A seat doing nothing at all, mid-exhale. */
export const STILL_MOTION: TellMotion = {
  tremor: 0,
  breathing: 0,
  sweat: 0,
  hands: [ZERO, ZERO],
  heldCards: { offset: ZERO, roll: 0 },
  head: { yaw: 0, pitch: 0 },
  breath: 0,
};

interface SeatState {
  target: SeatTells;
  tremor: number;
  breathing: number;
  sweat: number;
  breathPhase: number;
  phases: number[];
  motion: TellMotion;
}

/**
 * Every seat's tells, eased and animated.
 *
 * One per table, owned by the scene, read by both the avatars and the cards so
 * that a hand and the pair it is holding shake *together*. Clocked by the
 * caller so tests can step it.
 */
export class TableTells {
  #seats = new Map<number, SeatState>();
  #forced = new Map<number, SeatTells>();
  #time = 0;

  /** The broadcast. Only `tells` is read from it. */
  applyPresence(frame: PresenceFrame): void {
    for (const seat of frame.seats) this.setTells(seat.seatIndex, seat.tells);
  }

  setTells(seatIndex: number, tells: SeatTells): void {
    this.#state(seatIndex).target = this.#forced.get(seatIndex) ?? tells;
  }

  /**
   * Pins a seat's tells, or `null` to hand it back to the broadcast.
   *
   * Development only, for screenshots: a whole match is a long way to go to
   * find out what a soaked, shaking player looks like from across the felt.
   */
  force(seatIndex: number, tells: SeatTells | null): void {
    if (tells) {
      this.#forced.set(seatIndex, tells);
      this.#state(seatIndex).target = tells;
    } else {
      this.#forced.delete(seatIndex);
    }
  }

  /** Forgets a seat whose player has gone, so it does not stay frightened. */
  forget(seatIndex: number): void {
    this.#seats.delete(seatIndex);
  }

  update(deltaSeconds: number): void {
    const dt = Number.isFinite(deltaSeconds) ? Math.min(Math.max(deltaSeconds, 0), 0.25) : 0;
    this.#time += dt;
    const ease = 1 - Math.exp(-dt / TELL_MOTION.easeSeconds);
    const sweatEase = 1 - Math.exp(-dt / TELL_MOTION.sweatEaseSeconds);

    for (const state of this.#seats.values()) {
      state.tremor += (state.target.tremor - state.tremor) * ease;
      state.breathing += (state.target.breathing - state.breathing) * ease;
      state.sweat += (SWEAT_AMOUNT[state.target.sweat] - state.sweat) * sweatEase;

      const bpm =
        TELL_MOTION.breathsPerMinute.calm +
        (TELL_MOTION.breathsPerMinute.panic - TELL_MOTION.breathsPerMinute.calm) * state.breathing;
      state.breathPhase = (state.breathPhase + (dt * bpm) / 60) % 1;
      state.motion = motionFor(state, this.#time);
    }
  }

  /** What a seat's body is doing this frame. A seat never heard of is still. */
  motion(seatIndex: number): TellMotion {
    return this.#seats.get(seatIndex)?.motion ?? STILL_MOTION;
  }

  #state(seatIndex: number): SeatState {
    let state = this.#seats.get(seatIndex);
    if (!state) {
      state = {
        target: CALM,
        tremor: 0,
        breathing: 0,
        sweat: 0,
        breathPhase: seededPhases(seatIndex * 7 + 3, 1)[0]! / (Math.PI * 2),
        phases: seededPhases(seatIndex, 14),
        motion: STILL_MOTION,
      };
      this.#seats.set(seatIndex, state);
    }
    return state;
  }
}

/**
 * The movement a seat's eased tells produce at a moment.
 *
 * Shaking is a sum of a few incommensurate wobbles in the 6–11Hz band a real
 * hand shakes in, so it never settles into a rhythm. The two hands share a
 * body but not a nervous system, so they get their own phases; the held cards
 * share the right hand's, because that is the hand holding them.
 */
function motionFor(state: SeatState, t: number): TellMotion {
  const p = state.phases;
  // Squared, so a little tremor is very little: the bottom of the scale is
  // somebody who has gone slightly tense, not somebody shaking slightly.
  const shake = state.tremor * state.tremor;
  const hand = shake * TELL_MOTION.handMetres;

  const wobble = (a: number, b: number, fa: number, fb: number) =>
    0.6 * Math.sin(t * fa + p[a]!) + 0.4 * Math.sin(t * fb + p[b]!);

  const right: Offset = {
    x: hand * wobble(0, 1, 47.1, 66.3),
    y: hand * 0.7 * wobble(2, 3, 58.9, 39.7),
    z: hand * wobble(4, 5, 53.4, 71.9),
  };
  const left: Offset = {
    x: hand * wobble(6, 7, 49.8, 63.1),
    y: hand * 0.7 * wobble(8, 9, 61.2, 42.5),
    z: hand * wobble(10, 11, 55.6, 69.4),
  };

  const depth =
    TELL_MOTION.breathMetres.calm +
    (TELL_MOTION.breathMetres.panic - TELL_MOTION.breathMetres.calm) * state.breathing;
  // Half a sine shifted to sit at zero on the exhale: shoulders come *up* from
  // where they rest, they do not sink below it.
  const breath = depth * 0.5 * (1 - Math.cos(state.breathPhase * Math.PI * 2));

  return {
    tremor: state.tremor,
    breathing: state.breathing,
    sweat: state.sweat,
    hands: [right, left],
    heldCards: {
      offset: {
        x: right.x * TELL_MOTION.heldCardGain,
        y: right.y * TELL_MOTION.heldCardGain,
        z: right.z * TELL_MOTION.heldCardGain,
      },
      roll: shake * TELL_MOTION.heldCardRoll * wobble(12, 13, 44.2, 59.3),
    },
    head: {
      yaw: shake * TELL_MOTION.headRadians * wobble(1, 6, 37.3, 51.7),
      pitch: shake * TELL_MOTION.headRadians * 0.7 * wobble(3, 8, 41.9, 57.1),
    },
    breath,
  };
}

/** Fixed phases for a seat, so its shaking is its own and never anybody's. */
function seededPhases(seed: number, count: number): number[] {
  let s = ((seed + 1) * 2_654_435_761) >>> 0;
  return Array.from({ length: count }, () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return (s / 2 ** 32) * Math.PI * 2;
  });
}
