/**
 * Vocabulary shared by the authoritative engine, the network layer and the
 * client. Nothing in here knows about rendering, and nothing in here knows
 * about the horror layer.
 */

/** Betting streets. `SHOWDOWN` and `COMPLETE` are terminal bookkeeping phases. */
export const HAND_PHASES = ['PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'COMPLETE'] as const;
export type HandPhase = (typeof HAND_PHASES)[number];

/** The four dealing streets, in order. */
export const STREETS = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'] as const;
export type Street = (typeof STREETS)[number];

export const ACTION_TYPES = ['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * A player action. `BET` and `RAISE` carry `to`, the *total* the player will
 * have in front of them this street once the action resolves (raise-to
 * semantics, not raise-by). `ALL_IN` is sugar the server resolves into the
 * correct call/bet/raise so clients never have to compute stack maths.
 */
export type PlayerAction =
  | { type: 'FOLD' }
  | { type: 'CHECK' }
  | { type: 'CALL' }
  | { type: 'BET'; to: number }
  | { type: 'RAISE'; to: number }
  | { type: 'ALL_IN' };

/**
 * Everything a client needs to render a legal action bar. Computed by the
 * server; the client may use it for UI affordances but the server re-validates
 * every action against its own state regardless.
 */
export interface LegalActions {
  seatIndex: number;
  /** The amount a seat must have in front of it to have called. */
  currentBet: number;
  /** What this seat already has in front of it on this street. */
  betThisRound: number;
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** Chips the player must put in to call. Capped at their stack. */
  callAmount: number;
  /** True when a bet/raise of any size is legal (i.e. the player has chips and raise rights). */
  canRaise: boolean;
  /** Smallest legal raise-to. Equals `maxRaiseTo` when the only legal raise is all-in. */
  minRaiseTo: number;
  /** Largest legal raise-to: the player's entire stack. */
  maxRaiseTo: number;
  /** True when the player may only shove (stack too short for a full min-raise). */
  raiseIsAllInOnly: boolean;
  /**
   * Which action type to send for an aggressive move. Opening a street is a
   * `BET`; putting in more when there is already a bet is a `RAISE`. The engine
   * rejects the wrong one rather than guessing, so clients read it from here
   * instead of re-deriving it from state they should not need.
   */
  raiseActionType: 'BET' | 'RAISE';
}

export const HAND_CATEGORIES = [
  'HIGH_CARD',
  'PAIR',
  'TWO_PAIR',
  'THREE_OF_A_KIND',
  'STRAIGHT',
  'FLUSH',
  'FULL_HOUSE',
  'FOUR_OF_A_KIND',
  'STRAIGHT_FLUSH',
] as const;
export type HandCategory = (typeof HAND_CATEGORIES)[number];

/** Numeric rank of each category; higher always beats lower. */
export const HandCategoryValue = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
} as const satisfies Record<HandCategory, number>;
