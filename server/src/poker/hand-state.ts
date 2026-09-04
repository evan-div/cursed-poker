import type { Card, HandCategory, HandPhase, LegalActions, PlayerAction } from '@cursed/shared';
import type { SecretDeck } from './deck.js';

/** What the match layer hands the engine when a hand begins. */
export interface HandSeatInput {
  seatIndex: number;
  playerId: string;
  /** Chips behind. Must be > 0; seats without chips are not dealt in. */
  stack: number;
}

export interface HandConfig {
  smallBlind: number;
  bigBlind: number;
  /** Big-blind ante. 0 for no ante. */
  ante: number;
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

export interface ShowdownReveal {
  seatIndex: number;
  holeCards: [Card, Card];
  category: HandCategory;
  score: number;
  /** The five cards that make the hand, for highlighting. */
  bestFive: Card[];
}

export interface HandResult {
  /** Seats that were still in at the end, ascending. */
  contenders: number[];
  /** Null when the hand ended by everyone folding; nobody is required to show. */
  showdown: ShowdownReveal[] | null;
  uncalledReturn: { seatIndex: number; amount: number } | null;
  pots: { amount: number; eligibleSeats: number[] }[];
  awards: { potIndex: number; seatIndex: number; amount: number; oddChip: boolean }[];
  /** Final stack per seat, keyed by seat index. The match layer's source of truth. */
  finalStacks: Record<number, number>;
  /** Net chip change per seat. Sums to zero. */
  netChange: Record<number, number>;
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

/** An action after `ALL_IN` has been resolved into what it actually is. */
export type ResolvedAction =
  | { type: 'FOLD' }
  | { type: 'CHECK' }
  | { type: 'CALL'; amount: number }
  | { type: 'BET'; to: number; amount: number }
  | { type: 'RAISE'; to: number; amount: number };

export type HandEvent =
  | { type: 'HAND_STARTED'; handNumber: number; buttonSeat: number; config: HandConfig }
  | { type: 'ANTE_POSTED'; seatIndex: number; amount: number; allIn: boolean }
  | {
      type: 'BLIND_POSTED';
      seatIndex: number;
      blind: 'SMALL' | 'BIG';
      amount: number;
      allIn: boolean;
    }
  /** Carries no card data on purpose. Cards reach owners through projection. */
  | { type: 'HOLE_CARDS_DEALT'; seats: number[] }
  | { type: 'ACTION_REQUIRED'; seatIndex: number; legal: LegalActions }
  | {
      type: 'PLAYER_ACTED';
      seatIndex: number;
      /** The action as the client sent it, before resolution. */
      requested: PlayerAction;
      action: ResolvedAction;
      /** Stack after the action. */
      stack: number;
      allIn: boolean;
    }
  | { type: 'STREET_DEALT'; street: 'FLOP' | 'TURN' | 'RIVER'; cards: Card[]; board: Card[] }
  | { type: 'BETTING_ROUND_CLOSED'; phase: HandPhase; potTotal: number }
  | { type: 'UNCALLED_RETURNED'; seatIndex: number; amount: number }
  | { type: 'SHOWDOWN'; reveals: ShowdownReveal[] }
  | { type: 'POT_AWARDED'; potIndex: number; seatIndex: number; amount: number; oddChip: boolean }
  | { type: 'HAND_COMPLETE'; result: HandResult };

/** Thrown when a client sends an action that is not legal in the current state. */
export class IllegalActionError extends Error {
  override readonly name = 'IllegalActionError';
  constructor(message: string) {
    super(message);
  }
}
