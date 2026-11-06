import {
  COMPOSURE,
  NO_COMPOSURE,
  type ComposureChallengeView,
  type ComposureInput,
  type ComposureKind,
  type ComposureOutcome,
  type ComposureSpec,
  type ComposureView,
} from '@cursed/shared';
import type { RandomSource } from '../../poker/index.js';
import { breathChallenge } from './breath.js';
import type { ComposureChallenge, ComposureInputRecord } from './challenge.js';
import { holdChallenge } from './hold.js';

export type { ComposureChallenge, ComposureInputRecord } from './challenge.js';
export { scoreError } from './challenge.js';
export { BREATH, breathChallenge } from './breath.js';
export { HOLD, holdChallenge } from './hold.js';

/**
 * Composure, authoritatively.
 *
 * Holds each seat's running challenge and the last result, and does the one
 * thing composure is for: turns a seat's stress into the stress the table is
 * *shown*. It sits between `stress.ts` and the presence broadcast, and the
 * stress model never learns it exists — a composed player's heart is exactly
 * what it was.
 *
 * Plain data plus free functions, like everything else beside the table, so it
 * snapshots and replays with the match.
 */

/** The kinds a match issues by default. */
export const DEFAULT_COMPOSURE_KINDS: readonly ComposureChallenge[] = [breathChallenge, holdChallenge];

/** No challenge holds more inputs than this; past it, presses are ignored. */
const MAX_INPUTS = 32;

export interface RunningChallenge {
  id: string;
  kind: ComposureKind;
  spec: ComposureSpec;
  issuedAt: number;
  expiresAt: number;
  inputs: ComposureInputRecord[];
}

export interface ComposureResult {
  outcome: ComposureOutcome;
  quality: number;
  at: number;
  until: number;
}

export interface SeatComposure {
  seatIndex: number;
  challenge: RunningChallenge | null;
  result: ComposureResult | null;
  readyAt: number;
}

export interface ComposureState {
  seats: SeatComposure[];
  /** Challenges issued so far, for ids. */
  issued: number;
}

export function createComposure(): ComposureState {
  return { seats: [], issued: 0 };
}

function seatOf(state: ComposureState, seatIndex: number): SeatComposure {
  let seat = state.seats.find((s) => s.seatIndex === seatIndex);
  if (!seat) {
    seat = { seatIndex, challenge: null, result: null, readyAt: 0 };
    state.seats.push(seat);
  }
  return seat;
}

/** Why a challenge could not be started, or null if it can. */
export type ComposureRefusal = 'BUSY' | 'COOLING_DOWN' | 'NO_KINDS';

export function canBegin(state: ComposureState, seatIndex: number, now: number): ComposureRefusal | null {
  const seat = state.seats.find((s) => s.seatIndex === seatIndex);
  if (seat?.challenge) return 'BUSY';
  if (seat && now < seat.readyAt) return 'COOLING_DOWN';
  return null;
}

/**
 * Issues a challenge. The kind is the server's choice, never the player's.
 *
 * Throws on a refusal; `canBegin` says why beforehand.
 */
export function beginComposure(
  state: ComposureState,
  seatIndex: number,
  kinds: readonly ComposureChallenge[],
  rng: RandomSource,
  now: number,
): RunningChallenge {
  const refusal = kinds.length === 0 ? 'NO_KINDS' : canBegin(state, seatIndex, now);
  if (refusal) throw new Error(refusal);

  const kind = kinds[kinds.length === 1 ? 0 : rng.nextInt(kinds.length)]!;
  const { spec, durationMs } = kind.issue(rng);
  state.issued++;
  const challenge: RunningChallenge = {
    id: `c${state.issued}`,
    kind: kind.kind,
    spec,
    issuedAt: now,
    expiresAt: now + durationMs,
    inputs: [],
  };
  seatOf(state, seatIndex).challenge = challenge;
  return challenge;
}

/**
 * A key went down or came up. Timed here, by the server, on arrival.
 *
 * Returns the result if that input finished the challenge. An input for a
 * challenge that is not this seat's running one — an old id, a guess — is
 * ignored; there is nothing it could do.
 */
export function composureInput(
  state: ComposureState,
  seatIndex: number,
  challengeId: string,
  input: ComposureInput,
  kinds: readonly ComposureChallenge[],
  now: number,
): ComposureResult | null {
  const seat = state.seats.find((s) => s.seatIndex === seatIndex);
  const challenge = seat?.challenge;
  if (!seat || !challenge || challenge.id !== challengeId || now >= challenge.expiresAt) return null;
  if (challenge.inputs.length >= MAX_INPUTS) return null;

  challenge.inputs.push({ input, at: now });
  const kind = kinds.find((k) => k.kind === challenge.kind);
  const quality = kind?.judge(challenge.spec, challenge.inputs, false) ?? null;
  return quality === null ? null : finish(seat, quality, now);
}

/** Judges every challenge whose time is up, on whatever arrived. */
export function expireComposure(
  state: ComposureState,
  kinds: readonly ComposureChallenge[],
  now: number,
): { seatIndex: number; result: ComposureResult }[] {
  const finished: { seatIndex: number; result: ComposureResult }[] = [];
  for (const seat of state.seats) {
    const challenge = seat.challenge;
    if (!challenge || now < challenge.expiresAt) continue;
    const kind = kinds.find((k) => k.kind === challenge.kind);
    const quality = kind?.judge(challenge.spec, challenge.inputs, true) ?? 0;
    finished.push({ seatIndex: seat.seatIndex, result: finish(seat, quality, now) });
  }
  return finished;
}

function finish(seat: SeatComposure, quality: number, now: number): ComposureResult {
  const q = Math.min(Math.max(Number.isFinite(quality) ? quality : 0, 0), 1);
  const outcome: ComposureOutcome = q >= COMPOSURE.passAt ? 'STEADIED' : 'SHAKEN';
  const result: ComposureResult = {
    outcome,
    quality: q,
    at: now,
    until: now + (outcome === 'STEADIED' ? COMPOSURE.steadiedMs : COMPOSURE.shakenMs),
  };
  seat.challenge = null;
  seat.result = result;
  seat.readyAt = now + COMPOSURE.cooldownMs;
  return result;
}

/**
 * The stress the table is shown, given the stress a seat actually has.
 *
 * The whole effect of composure, in one function. A success hides a share of
 * it that fades over half a minute; a failure adds to it, as a share of the
 * headroom left, and fades faster. Nothing else is touched — not the stress
 * itself, not the heart rate its owner is told.
 */
export function visibleStress(state: ComposureState, seatIndex: number, stress: number, now: number): number {
  const result = state.seats.find((s) => s.seatIndex === seatIndex)?.result;
  if (!result || now >= result.until || now < result.at) return stress;

  const remaining = (result.until - now) / (result.until - result.at);
  if (result.outcome === 'STEADIED') {
    const skill = (result.quality - COMPOSURE.passAt) / (1 - COMPOSURE.passAt);
    const { atPass, atBest } = COMPOSURE.steadiedHides;
    const hides = (atPass + (atBest - atPass) * Math.min(Math.max(skill, 0), 1)) * remaining;
    return stress * (1 - hides);
  }
  return stress + COMPOSURE.shakenAdds * remaining * (1 - stress);
}

/** What a player is told about their own composure. */
export function composureView(state: ComposureState, seatIndex: number | null, now: number): ComposureView {
  if (seatIndex === null) return NO_COMPOSURE;
  const seat = state.seats.find((s) => s.seatIndex === seatIndex);
  if (!seat) return NO_COMPOSURE;

  const challenge: ComposureChallengeView | null = seat.challenge
    ? {
        id: seat.challenge.id,
        kind: seat.challenge.kind,
        spec: seat.challenge.spec,
        issuedAt: seat.challenge.issuedAt,
        expiresAt: seat.challenge.expiresAt,
      }
    : null;
  const result =
    seat.result && now < seat.result.until
      ? { outcome: seat.result.outcome, quality: seat.result.quality, until: seat.result.until }
      : null;
  return { challenge, result, readyAt: seat.readyAt };
}

/** Drops a seat's challenge and effect, when they are eliminated or leave. */
export function forgetComposure(state: ComposureState, seatIndex: number): void {
  const index = state.seats.findIndex((s) => s.seatIndex === seatIndex);
  if (index >= 0) state.seats.splice(index, 1);
}
