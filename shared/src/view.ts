/**
 * What a player is allowed to see.
 *
 * Every byte of match state that reaches a client arrives as a `ClientView`,
 * built by exactly one function on the server (`projectForViewer`). Nothing else
 * serialises match state toward a client, which is what makes "did we leak a
 * hole card?" a question with one place to look and one test suite to answer it.
 *
 * The shape reflects that boundary: `you` carries the viewer's own secrets, and
 * `hand.seats[].revealedCards` is populated only for cards poker itself has made
 * public at showdown. There is no field anywhere in here that can hold another
 * player's live hole cards.
 */
import type { Card } from './cards.js';
import type { HandResult } from './hand-events.js';
import type { HandCategory, HandPhase, LegalActions } from './poker-types.js';

export const MATCH_STATUSES = ['LOBBY', 'IN_PROGRESS', 'FINISHED'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** The outer state machine. Horror systems only ever run in `BETWEEN_HANDS`. */
export const MATCH_PHASES = ['LOBBY', 'HAND_IN_PROGRESS', 'BETWEEN_HANDS', 'MATCH_END'] as const;
export type MatchPhase = (typeof MATCH_PHASES)[number];

export interface PlayerView {
  playerId: string;
  displayName: string;
  seatIndex: number | null;
  connected: boolean;
  ready: boolean;
  isHost: boolean;
  /** False once the Dealer has taken them. Their chair stays at the table. */
  seated: boolean;
}

export interface SeatView {
  seatIndex: number;
  playerId: string;
  displayName: string;
  stack: number;
  /** Chips in front of this seat on the current street. */
  betThisRound: number;
  folded: boolean;
  allIn: boolean;
  /** Dealt into the hand in progress. */
  inHand: boolean;
  connected: boolean;
  /**
   * Cards poker has made public. Non-null only for a showdown reveal — never
   * for a live hand, never for a player who won without showing.
   */
  revealedCards: Card[] | null;
  handCategory: HandCategory | null;
  bestFive: Card[] | null;
}

export interface HandView {
  handNumber: number;
  phase: HandPhase;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  board: Card[];
  /** The amount a seat must have in front of it to have called. */
  currentBet: number;
  /** Everything committed to the hand so far, live street bets included. */
  potTotal: number;
  actingSeat: number | null;
  /** Epoch milliseconds by which the acting seat must act, or null. */
  actionDeadline: number | null;
  seats: SeatView[];
}

/** The viewer's own state. The only place a live hole card may appear. */
export interface SelfView {
  playerId: string;
  seatIndex: number | null;
  /**
   * The viewer's own two cards — **once they have looked at them**.
   *
   * Null until this player peeks in this hand, and null again the moment the
   * next one is dealt. Cards are not pushed at the deal, because a client that
   * is handed its cards for free can render them for a whole hand without ever
   * moving, and then peeking is decoration: an animation a modified client
   * would simply skip.
   *
   * Making the look load-bearing costs one gesture a hand and buys the thing the
   * game is about — every player must physically lift their cards at least once,
   * in front of everybody, and every lift after that is a decision somebody
   * might be watching.
   */
  holeCards: Card[] | null;
  /** Whether this player has looked at their cards in the current hand. */
  hasPeeked: boolean;
  /** Null unless it is this player's turn. */
  legalActions: LegalActions | null;
}

export interface LevelView {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  /** Epoch milliseconds when this level ends, or null while the clock is paused. */
  endsAt: number | null;
}

export interface ClientView {
  /** Server time when this view was built, so clients can align countdowns. */
  serverTime: number;
  room: {
    code: string;
    status: MatchStatus;
    phase: MatchPhase;
    hostPlayerId: string;
  };
  level: LevelView | null;
  players: PlayerView[];
  hand: HandView | null;
  you: SelfView;
  /** Summary of the hand just finished, cleared when the next one starts. */
  lastResult: HandResult | null;
  /** Set once one player is left standing. */
  winnerPlayerId: string | null;
}
