/**
 * The public record of a hand.
 *
 * These types are the wire protocol for narration: the engine's event stream is
 * what the client animates from. Everything here is safe to send to every player
 * at the table — hole cards appear only inside a showdown reveal, which is
 * public by the rules of poker.
 *
 * The secret half of a hand (the deck, the burn pile, live hole cards) lives in
 * server-only types and has no representation here at all.
 */
import type { Card } from './cards.js';
import type { HandCategory, HandPhase, LegalActions, PlayerAction } from './poker-types.js';

export interface HandConfig {
  smallBlind: number;
  bigBlind: number;
  /** Big-blind ante. 0 for no ante. */
  ante: number;
}

/** An action after `ALL_IN` has been resolved into what it actually is. */
export type ResolvedAction =
  | { type: 'FOLD' }
  | { type: 'CHECK' }
  | { type: 'CALL'; amount: number }
  | { type: 'BET'; to: number; amount: number }
  | { type: 'RAISE'; to: number; amount: number };

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
