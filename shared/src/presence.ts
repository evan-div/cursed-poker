/**
 * Bodies at the table.
 *
 * Phase 4 adds a second kind of state to the protocol. `ClientView` is the
 * *situation* — chips, cards, whose turn it is — and changes only when poker
 * changes. Presence is the *body*: where somebody is looking, whether their
 * cards are lifted, whether their hands are on their chips. It changes many
 * times a second and matters for exactly one frame.
 *
 * Three rules shape everything in this file.
 *
 * **Presence is public.** Every field here is something a person sitting at this
 * table could see with their own eyes. There is no viewer-specific presence, no
 * hidden half, and nothing in a `PresenceFrame` that a spectator could not also
 * be told. That is what makes "did presence leak anything?" answerable by
 * reading the type.
 *
 * **Presence is an input, not local state.** A client reports its own body to
 * the server and the server decides what the table sees. A client cannot
 * suppress its own tells by staying quiet: silence is replicated as stillness,
 * which is itself information, and often the loudest kind.
 *
 * **Presence is coarse on purpose.** Gaze is a *target*, not a vector. Six
 * players' head angles streamed at 15 Hz would let a script measure micro-
 * movements no human eye could resolve, which would make tell-reading a
 * programming exercise. Quantising to "they are looking at seat 4" bounds the
 * signal to roughly what a person could actually perceive, and it is also
 * one byte instead of twelve.
 */

/**
 * What somebody appears to be looking at.
 *
 * `AWAY` covers everything that is not one of the named points of interest —
 * the dark, the ceiling, their own lap. It is a real answer, not a missing one:
 * a player who stares into the corner during a big bet is telling you something.
 */
export const GAZE_KINDS = [
  'DEALER',
  'SEAT',
  'BOARD',
  'POT',
  'OWN_CARDS',
  'OWN_CHIPS',
  'AWAY',
] as const;
export type GazeKind = (typeof GAZE_KINDS)[number];

export type GazeTarget =
  | { kind: 'SEAT'; seatIndex: number }
  | { kind: Exclude<GazeKind, 'SEAT'> };

export const GAZE_AWAY: GazeTarget = { kind: 'AWAY' };

export function gazeEquals(a: GazeTarget, b: GazeTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'SEAT' && b.kind === 'SEAT') return a.seatIndex === b.seatIndex;
  return true;
}

/** Tuning for the peek gesture. Feel, not rules — nothing here reaches poker. */
export const PEEK = {
  /**
   * Pointer travel, in pixels, from flat on the felt to fully lifted. Tuned so
   * that reading a rank takes a deliberate movement rather than a twitch.
   */
  travelPixels: 190,
  /** How far the near edge of a card lifts at full exposure, in radians. */
  maxLift: 1.15,
  /** Exposure at which a rank becomes readable; below this it is a corner. */
  rankVisibleAt: 0.34,
  /** How quickly a released card falls back to the felt, in exposure per second. */
  dropPerSecond: 5.5,
  /**
   * Replicated exposure is rounded to this many steps. Fine enough to animate,
   * coarse enough that measuring an opponent's exposure is pointless.
   */
  quantiseSteps: 16,
} as const;

/**
 * The rates the body channel runs at.
 *
 * These four numbers are a system, not a list, and the relationship between two
 * of them is load-bearing: **`graceMs` must comfortably exceed `heartbeatMs`.**
 * A client that is holding perfectly still sends nothing but heartbeats, so if
 * the server starts decaying sooner than the next heartbeat arrives, every held
 * card at the table sags and springs back twice a second — which is exactly the
 * bug this comment exists to prevent a second time. `presence.test.ts` asserts
 * the margin so the constants cannot drift apart quietly.
 */
export const PRESENCE = {
  /** How often a client may report its own body. */
  clientHz: 15,
  /** How often the server broadcasts the table's bodies. */
  broadcastHz: 12,
  /** A report is sent at least this often even when nothing changed. */
  heartbeatMs: 500,
  /**
   * How long a body is held at face value before it starts to decay.
   *
   * Two missed heartbeats. Below this nothing moves on its own, so ordinary
   * jitter, a dropped packet and a busy frame all look like what they are:
   * nothing happening.
   */
  graceMs: 1_250,
  /**
   * How long an unreported peek takes to fall back to the felt, once the grace
   * window has passed. A client that stops sending does not freeze mid-lift;
   * its cards drop, and its stillness starts counting.
   */
  peekDecayMs: 600,
  /** Above this, a seat reads as unnaturally still. */
  stillnessMs: 1_200,
} as const;

/** Rounds an exposure to the replicated resolution. */
export function quantisePeek(value: number): number {
  const clamped = Math.min(Math.max(value, 0), 1);
  return Math.round(clamped * PEEK.quantiseSteps) / PEEK.quantiseSteps;
}

/** What a client reports about its own body. */
export interface PresenceInput {
  gaze: GazeTarget;
  /** How far this player has lifted their own cards, 0..1. */
  peek: number;
  /** True while they are handling chips — sizing a bet, reaching for a stack. */
  handlingChips: boolean;
}

/**
 * One seat's body, as everyone at the table sees it.
 *
 * Note what is *not* here: no heart rate, no stress, no hand strength, no card.
 * Phase 6 will add derived tell values (tremor, breathing, sweat) alongside
 * these, computed on the server from state the client never sees.
 */
export interface SeatPresence {
  seatIndex: number;
  gaze: GazeTarget;
  /** How far their cards are lifted. Never what is on them. */
  peek: number;
  handlingChips: boolean;
  /**
   * How long this seat has been completely motionless, in milliseconds.
   *
   * Silence is not privacy. A player who stops reporting does not disappear;
   * they become still, and stillness is one of the tells the brief asks for.
   */
  stillMs: number;
  /** False while the player is away; an empty chair does not fidget. */
  present: boolean;
}

export interface PresenceFrame {
  serverTime: number;
  seats: SeatPresence[];
}
