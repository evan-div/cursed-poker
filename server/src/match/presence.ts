import {
  GAZE_AWAY,
  PRESENCE,
  gazeEquals,
  quantisePeek,
  type GazeTarget,
  type PresenceFrame,
  type PresenceInput,
  type SeatPresence,
} from '@cursed/shared';

/**
 * The table's bodies, authoritatively.
 *
 * This module owns every physical thing a player does that is not a poker
 * action: where they are looking, whether their cards are lifted, whether their
 * hands are on their chips, and how long they have been perfectly still.
 *
 * It is deliberately outside the poker engine and cannot reach into it. It reads
 * nothing from a hand and writes nothing to one. The single point of contact in
 * the other direction is `peekedHand`, which records *that* a player looked at
 * their own cards — never what they saw.
 *
 * Plain data plus free functions, in the style of `match-state.ts`, so the whole
 * thing snapshots, replays and diffs like the rest of the match.
 */

/** Smallest change in exposure anyone could actually notice. */
const VISIBLE_MOVEMENT = 0.005;

export interface SeatPresenceRecord {
  seatIndex: number;
  /** Last reported gaze. Held after a client goes quiet: a frozen head is a fact. */
  gaze: GazeTarget;
  /** Last reported exposure, before decay. */
  peek: number;
  handlingChips: boolean;
  /** Epoch ms of the last report that actually changed something. */
  lastMovedAt: number;
  /** Epoch ms of the last report of any kind, changed or not. */
  lastReportAt: number;
  /**
   * The hand number this player looked at their own cards in, or null.
   *
   * The only bridge between a body and a hand, and it carries one bit: they
   * looked. `projection.ts` reads it to decide whether to hand this player their
   * own cards; nothing else may read it, and nothing at all replicates it to
   * anyone but its owner.
   */
  peekedHand: number | null;
  /** How many times they lifted their cards in the current hand. */
  peeksThisHand: number;
  /**
   * Total time spent with cards lifted this hand, in milliseconds.
   *
   * Nobody is told this. It is here because Phase 6's stress model wants it —
   * a player who spends nine seconds staring at the same two cards is under a
   * different kind of pressure than one who glances once.
   */
  peekMsThisHand: number;
}

/**
 * One record per seat that has ever reported.
 *
 * An array rather than a map, so match state stays plain JSON that snapshots,
 * replays and diffs like everything else in `match-state.ts`.
 */
export type PresenceState = SeatPresenceRecord[];

export function createPresence(): PresenceState {
  return [];
}

function findSeat(presence: PresenceState, seatIndex: number): SeatPresenceRecord | undefined {
  return presence.find((record) => record.seatIndex === seatIndex);
}

function blank(seatIndex: number, now: number): SeatPresenceRecord {
  return {
    seatIndex,
    gaze: GAZE_AWAY,
    peek: 0,
    handlingChips: false,
    lastMovedAt: now,
    lastReportAt: now,
    peekedHand: null,
    peeksThisHand: 0,
    peekMsThisHand: 0,
  };
}

export function seatPresence(
  presence: PresenceState,
  seatIndex: number,
  now: number,
): SeatPresenceRecord {
  let record = findSeat(presence, seatIndex);
  if (!record) {
    record = blank(seatIndex, now);
    presence.push(record);
  }
  return record;
}

/**
 * Records what a client says its body is doing.
 *
 * Nothing here is trusted in the sense that matters — a client can lie about
 * where it is looking, exactly as a person can look at your chips out of the
 * corner of their eye. That is a poker skill, not an exploit. What a client
 * *cannot* do is stay silent to hide: the seat keeps replicating, and the
 * stillness clock starts running the moment the reports stop.
 */
export function reportPresence(
  presence: PresenceState,
  seatIndex: number,
  input: PresenceInput,
  now: number,
): void {
  const record = seatPresence(presence, seatIndex, now);
  const peek = clamp01(input.peek);

  if (record.peek > 0 && now > record.lastReportAt) {
    // Time spent lifted, integrated between reports. Phase 6 reads it; nobody
    // else ever will.
    record.peekMsThisHand += Math.min(now - record.lastReportAt, 1_000);
  }

  // Movement too small to see is not movement. Without a floor here, pointer
  // jitter would keep the stillness clock permanently at zero and nobody would
  // ever read as unnaturally still.
  const moved =
    !gazeEquals(record.gaze, input.gaze) ||
    Math.abs(record.peek - peek) > VISIBLE_MOVEMENT ||
    record.handlingChips !== input.handlingChips;

  record.gaze = input.gaze;
  record.peek = peek;
  record.handlingChips = input.handlingChips;
  record.lastReportAt = now;
  if (moved) record.lastMovedAt = now;
}

/**
 * Marks a seat as having looked at its own cards this hand.
 *
 * Returns true the first time in a given hand, which is what the caller uses to
 * decide whether a fresh view needs pushing.
 */
export function markPeeked(
  presence: PresenceState,
  seatIndex: number,
  handNumber: number,
  now: number,
): boolean {
  const record = seatPresence(presence, seatIndex, now);
  record.peeksThisHand++;
  record.lastMovedAt = now;
  if (record.peekedHand === handNumber) return false;
  record.peekedHand = handNumber;
  return true;
}

export function hasPeeked(
  presence: PresenceState,
  seatIndex: number | null,
  handNumber: number | null,
): boolean {
  if (seatIndex === null || handNumber === null) return false;
  return findSeat(presence, seatIndex)?.peekedHand === handNumber;
}

/**
 * Clears the per-hand bookkeeping when a new hand is dealt.
 *
 * Bodies persist across hands — a head does not snap back to centre because the
 * deck was shuffled — but the record of having looked does not, which is what
 * forces every player to lift their cards again every hand.
 */
export function resetForHand(presence: PresenceState, now: number): void {
  for (const record of presence) {
    record.peekedHand = null;
    record.peeksThisHand = 0;
    record.peekMsThisHand = 0;
    record.peek = 0;
    record.lastReportAt = now;
  }
}

export function forgetSeat(presence: PresenceState, seatIndex: number): void {
  const index = presence.findIndex((record) => record.seatIndex === seatIndex);
  if (index >= 0) presence.splice(index, 1);
}

export interface PresenceFrameOptions {
  /** Seats currently at the table, in seat order. */
  seatIndices: readonly number[];
  /** Seats whose player is connected. Everyone else stops moving entirely. */
  connected: ReadonlySet<number>;
}

/**
 * The public frame.
 *
 * Every field is something a person in a chair at this table could see. There is
 * no viewer parameter because there is nothing here to hide from anyone — which
 * is a property worth keeping, because it is what makes this a cheap broadcast
 * instead of six projections.
 */
export function projectPresence(
  presence: PresenceState,
  options: PresenceFrameOptions,
  now: number,
): PresenceFrame {
  const seats: SeatPresence[] = options.seatIndices.map((seatIndex) => {
    const record = findSeat(presence, seatIndex);
    const present = options.connected.has(seatIndex);

    if (!record) {
      return {
        seatIndex,
        gaze: GAZE_AWAY,
        peek: 0,
        handlingChips: false,
        stillMs: 0,
        present,
      };
    }

    // A client that stops reporting does not freeze mid-lift. Its cards fall,
    // its hands come off its chips, and the stillness clock keeps running.
    // Ordinary gaps between reports are absorbed by the grace window, so a seat
    // that is behaving normally is replicated at face value.
    const quiet = Math.max(0, now - record.lastReportAt - PRESENCE.graceMs);
    const decay = quiet <= 0 ? 1 : Math.max(0, 1 - quiet / PRESENCE.peekDecayMs);

    return {
      seatIndex,
      gaze: record.gaze,
      peek: present ? quantisePeek(record.peek * decay) : 0,
      handlingChips: present && record.handlingChips && decay > 0,
      stillMs: Math.max(0, now - record.lastMovedAt),
      present,
    };
  });

  return { serverTime: now, seats };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
