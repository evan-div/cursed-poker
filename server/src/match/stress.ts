import {
  CALM,
  COMPOSED,
  STRESS,
  STRESS_WEIGHTS,
  heartRateFor,
  tellsFor,
  type SeatTells,
  type SelfStress,
  type StressEvent,
} from '@cursed/shared';

/**
 * How frightened everybody is, authoritatively.
 *
 * The server owns this and the client never computes it, for the reason the
 * architecture gives: a modified client that computed its own tells would simply
 * compute zero, and sit there looking serene through the worst hand of its life.
 * The number has to live somewhere a patched build cannot reach.
 *
 * **It may not read a card.** See the long note at the top of
 * `shared/src/stress.ts` — that rule is the phase, and `stress-boundary.test.ts`
 * enforces it through whole running matches rather than by inspection.
 *
 * Two kinds of pressure, kept apart because they behave differently:
 *
 *   - **Spikes** are things that happened. They are added when they happen and
 *     they fade, each at its own rate. Winning a pot spikes nearly as hard as
 *     losing one and then falls away twice as fast, because that is what relief
 *     is.
 *   - **The floor** is what has not stopped happening. Four big blinds left, a
 *     dark room, the Dealer's head pointed at you. It does not decay, because
 *     the situation has not gone anywhere, and stress can never fall below it.
 *
 * Plain data plus free functions, like `presence.ts` and `dealer.ts`, so it
 * snapshots and replays with the rest of the match.
 */

export interface SeatStressRecord {
  seatIndex: number;
  /**
   * The decaying part, 0..1 before the floor is applied.
   *
   * Stored with the time it was last advanced rather than ticked, so a room
   * nobody is looking at costs nothing and a replay lands on the same numbers
   * whatever rate it was stepped at.
   */
  spike: number;
  /** When `spike` was last brought up to date. */
  decayedAt: number;
  /** The standing pressure, recomputed from the situation rather than stored. */
  floor: number;
  /**
   * What last happened to them, and when.
   *
   * Kept for the replay harness and for a log that can be read by a person:
   * "seat 3, FACED_ALL_IN" says something that a stress of 0.61 does not.
   */
  lastEvent: StressEvent | null;
  lastEventAt: number | null;
}

export type StressState = SeatStressRecord[];

export function createStress(): StressState {
  return [];
}

function find(stress: StressState, seatIndex: number): SeatStressRecord | undefined {
  return stress.find((record) => record.seatIndex === seatIndex);
}

function recordFor(stress: StressState, seatIndex: number, now: number): SeatStressRecord {
  let record = find(stress, seatIndex);
  if (!record) {
    record = {
      seatIndex,
      spike: 0,
      decayedAt: now,
      floor: 0,
      lastEvent: null,
      lastEventAt: null,
    };
    stress.push(record);
  }
  return record;
}

/**
 * Brings the decaying part up to date.
 *
 * Exponential, at a half-life scaled by the event's own relief. Done lazily on
 * read and on write rather than on a tick: there is no reason for an idle table
 * to burn CPU being calm, and a lazily decayed value is the same value.
 */
function decay(record: SeatStressRecord, now: number): void {
  const elapsed = Math.max(0, now - record.decayedAt);
  record.decayedAt = now;
  if (elapsed === 0 || record.spike <= 0) return;

  const relief = record.lastEvent ? STRESS_WEIGHTS[record.lastEvent].relief : 1;
  const halfLife = STRESS.halfLifeMs / Math.max(relief, 0.05);
  record.spike *= Math.pow(0.5, elapsed / halfLife);
  if (record.spike < 1e-4) record.spike = 0;
}

/**
 * Something happened to somebody.
 *
 * `intensity` scales the event's own weight, 0..1, and is how a bet of three
 * big blinds is told apart from one of ninety. It is always derived from public
 * numbers — chips and stacks are on everybody's screen.
 */
export function applyStressEvent(
  stress: StressState,
  seatIndex: number,
  event: StressEvent,
  now: number,
  intensity = 1,
): void {
  const record = recordFor(stress, seatIndex, now);
  decay(record, now);

  const scaled = Math.min(Math.max(intensity, 0), 1);
  record.spike = Math.min(1, record.spike + STRESS_WEIGHTS[event].spike * scaled);
  record.lastEvent = event;
  record.lastEventAt = now;
}

/**
 * The pressures that have not stopped.
 *
 * Every one of these is on the table in front of everybody: a stack size, a
 * blind level, an empty chair, the Dealer's head. Recomputed each time rather
 * than stored, because a floor derived from the current situation cannot drift
 * out of step with it.
 */
export interface StandingPressure {
  seatIndex: number;
  /** Their stack, in big blinds. */
  stackBlinds: number;
  /** The room's dread, 0..1. */
  dread: number;
  /** True while the Dealer is looking at this seat. */
  watched: boolean;
  /** True while they are in a live hand with chips committed. */
  inHand: boolean;
}

export function floorFor(pressure: StandingPressure): number {
  // Short-stacked. The one that makes a tournament a tournament.
  const span = STRESS.comfortableBlinds - STRESS.desperateBlinds;
  const shortness = clamp01((STRESS.comfortableBlinds - pressure.stackBlinds) / span);
  const short = pressure.inHand ? shortness : shortness * 0.6;

  // The room itself. Everybody feels this one, and it only goes up.
  const room = pressure.dread * 0.45;

  // Something at the head of the table is looking at you.
  const watched = pressure.watched ? 0.25 : 0;

  return clamp01(Math.max(short, room, watched) * STRESS.floorWeight);
}

/** Recomputes the standing floor for every seat given. */
export function settleStress(
  stress: StressState,
  pressures: StandingPressure[],
  now: number,
): void {
  for (const pressure of pressures) {
    const record = recordFor(stress, pressure.seatIndex, now);
    decay(record, now);
    record.floor = floorFor(pressure);
  }
}

/** Where a seat actually is, 0..1. The floor is a floor, not an addition. */
export function stressOf(stress: StressState, seatIndex: number, now: number): number {
  const record = find(stress, seatIndex);
  if (!record) return 0;
  decay(record, now);
  return clamp01(Math.max(record.floor, record.floor + record.spike * (1 - record.floor)));
}

/**
 * What the table sees of one seat.
 *
 * Quantised on the way out — see `STRESS.tellSteps`. A tremor at full precision,
 * differenced frame to frame, is a far better read than any eye could make.
 */
export function projectTells(stress: StressState, seatIndex: number, now: number): SeatTells {
  const record = find(stress, seatIndex);
  if (!record) return CALM;
  return tellsFor(stressOf(stress, seatIndex, now));
}

/** What a player is told about their own body. Owner-only. */
export function projectSelfStress(
  stress: StressState,
  seatIndex: number | null,
  now: number,
): SelfStress {
  if (seatIndex === null) return COMPOSED;
  const level = stressOf(stress, seatIndex, now);
  return { heartRate: heartRateFor(level), stress: Math.round(level * 1000) / 1000 };
}

/**
 * Forgets a seat entirely.
 *
 * Called when somebody leaves the lobby. An eliminated player keeps their
 * record: the chair is empty but the match is not over, and Phase 9 will have
 * things to say about what is left behind.
 */
export function forgetStress(stress: StressState, seatIndex: number): void {
  const index = stress.findIndex((record) => record.seatIndex === seatIndex);
  if (index >= 0) stress.splice(index, 1);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
