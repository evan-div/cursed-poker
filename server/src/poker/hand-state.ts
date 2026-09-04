import type { Card, HandConfig, HandPhase, HandResult } from '@cursed/shared';
import type { SecretDeck } from './deck.js';

/**
 * Server-only hand state.
 *
 * The public record of a hand — events, results, showdown reveals — lives in
 * `@cursed/shared` because it is the wire protocol. What stays here is the
 * secret half: the deck, the burn pile, and live hole cards. Nothing in this
 * file may be serialised toward a client.
 */

/** What the match layer hands the engine when a hand begins. */
export interface HandSeatInput {
  seatIndex: number;
  playerId: string;
  /** Chips behind. Must be > 0; seats without chips are not dealt in. */
  stack: number;
}

export interface HandSeatState {
  seatIndex: number;
  playerId: string;
  /** Stack before any chips went in this hand. Used for chip-conservation checks. */
  stackAtStart: number;
  stack: number;
  /** Chips in front of this seat on the current street. */
  betThisRound: number;
  /** Chips this seat has put into the hand in total, antes included. */
  totalCommitted: number;
  /** Forced money that is not a live bet (the big-blind ante). */
  deadCommitted: number;
  folded: boolean;
  allIn: boolean;
  /** Has acted voluntarily at the current bet level. Blinds do not count. */
  hasActedThisRound: boolean;
  /** False once an undersized all-in has closed this seat's raise rights. */
  mayRaise: boolean;
  /** SECRET. Only ever projected to the owning player, or publicly at showdown. */
  holeCards: [Card, Card] | null;
}

export interface HandState {
  handNumber: number;
  phase: HandPhase;
  config: HandConfig;
  /** Physical table size, used for clockwise ordering. */
  seatCount: number;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  /** Only the seats dealt into this hand, ascending by seat index. */
  seats: HandSeatState[];
  board: Card[];
  /** Burned cards, kept so replays are exact. Never projected. */
  burned: Card[];
  /** The amount a seat must have in front of it to have called. */
  currentBet: number;
  /** Size of the last full raise; the minimum increment for the next one. */
  lastFullRaiseSize: number;
  actingSeat: number | null;
  /** SECRET. See `SecretDeck`. */
  deck: SecretDeck;
  result: HandResult | null;
}

/** Thrown when a client sends an action that is not legal in the current state. */
export class IllegalActionError extends Error {
  override readonly name = 'IllegalActionError';
  constructor(message: string) {
    super(message);
  }
}
