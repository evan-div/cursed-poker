import type {
  Card,
  HandConfig,
  HandEvent,
  HandPhase,
  HandResult,
  LegalActions,
  PlayerAction,
  ResolvedAction,
  ShowdownReveal,
} from '@cursed/shared';
import { burn, draw, drawMany, shuffledDeck, type SecretDeck } from './deck.js';
import { bestFiveCards, evaluate } from './evaluator.js';
import { awardPots, buildPots, type PotContribution } from './pots.js';
import { CryptoRandomSource, type RandomSource } from './random.js';
import {
  IllegalActionError,
  type HandSeatInput,
  type HandSeatState,
  type HandState,
} from './hand-state.js';

/**
 * No-Limit Texas Hold'em, one hand at a time.
 *
 * This module is the load-bearing wall of the whole project. It knows nothing
 * about Three.js, sockets, stress, perks, sacrifices or the Dealer, and it must
 * stay that way: every horror system reads poker state and reacts to poker
 * events, and none of them may write into it. A hand played here is a hand of
 * honest poker or it is a bug.
 *
 * The API is a pure state machine:
 *
 *     let { state, events } = createHand(options);
 *     while (state.actingSeat !== null) {
 *       ({ state, events } = applyAction(state, state.actingSeat, someAction));
 *     }
 *     // state.phase === 'COMPLETE', state.result holds the payouts
 *
 * `applyAction` never mutates the state it is given; it returns a new one. The
 * engine advances itself as far as it can after each action, so the returned
 * state is always either waiting on a specific seat or complete.
 */

export interface CreateHandOptions {
  handNumber: number;
  /** Every seat being dealt in. 2..seatCount of them, all with chips. */
  seats: readonly HandSeatInput[];
  buttonSeat: number;
  /** Physical table size. Governs clockwise ordering, not who is dealt in. */
  seatCount: number;
  config: HandConfig;
  rng?: RandomSource;
  /** Pre-arranged deck. Tests and replays only — never reachable from a match. */
  deck?: SecretDeck;
}

export interface EngineStep {
  state: HandState;
  events: HandEvent[];
}

// ---------------------------------------------------------------------------
// Hand setup
// ---------------------------------------------------------------------------

export function createHand(options: CreateHandOptions): EngineStep {
  const { handNumber, seats, buttonSeat, seatCount, config } = options;

  validateSetup(options);

  const ordered = [...seats].sort((a, b) => a.seatIndex - b.seatIndex);
  const seatStates: HandSeatState[] = ordered.map((s) => ({
    seatIndex: s.seatIndex,
    playerId: s.playerId,
    stackAtStart: s.stack,
    stack: s.stack,
    betThisRound: 0,
    totalCommitted: 0,
    deadCommitted: 0,
    folded: false,
    allIn: false,
    hasActedThisRound: false,
    mayRaise: true,
    holeCards: null,
  }));

  const occupied = seatStates.map((s) => s.seatIndex);
  const headsUp = occupied.length === 2;
  // Heads-up is the one place the button moves: it posts the small blind and
  // acts first before the flop, last after it.
  const smallBlindSeat = headsUp ? buttonSeat : nextOccupiedSeat(occupied, buttonSeat, seatCount);
  const bigBlindSeat = nextOccupiedSeat(occupied, smallBlindSeat, seatCount);

  const state: HandState = {
    handNumber,
    phase: 'PREFLOP',
    config,
    seatCount,
    buttonSeat,
    smallBlindSeat,
    bigBlindSeat,
    seats: seatStates,
    board: [],
    burned: [],
    currentBet: 0,
    lastFullRaiseSize: config.bigBlind,
    actingSeat: null,
    deck: options.deck ?? shuffledDeck(options.rng ?? new CryptoRandomSource()),
    result: null,
  };

  const events: HandEvent[] = [{ type: 'HAND_STARTED', handNumber, buttonSeat, config }];

  postAntes(state, events);
  postBlinds(state, events);
  dealHoleCards(state, events);

  // Players must match the full big blind even when a short stack posted less
  // than one, so the level's nominal blind is the opening bet.
  state.currentBet = config.bigBlind;
  state.lastFullRaiseSize = config.bigBlind;

  // Preflop action starts to the left of the big blind. Heads-up that wraps
  // around to the button, which is exactly right.
  state.actingSeat = null;
  advance(state, events, bigBlindSeat);

  return { state, events };
}

function validateSetup(options: CreateHandOptions): void {
  const { seats, buttonSeat, seatCount, config } = options;

  if (seatCount < 2) throw new Error(`seatCount must be at least 2, got ${seatCount}`);
  if (seats.length < 2) throw new Error(`A hand needs at least 2 seats, got ${seats.length}`);
  if (seats.length > seatCount) {
    throw new Error(`${seats.length} seats do not fit at a ${seatCount}-seat table`);
  }
  if (new Set(seats.map((s) => s.seatIndex)).size !== seats.length) {
    throw new Error('Duplicate seatIndex in hand setup');
  }
  for (const s of seats) {
    if (!Number.isInteger(s.seatIndex) || s.seatIndex < 0 || s.seatIndex >= seatCount) {
      throw new Error(`seatIndex ${s.seatIndex} is outside a ${seatCount}-seat table`);
    }
    if (!Number.isInteger(s.stack) || s.stack <= 0) {
      throw new Error(`Seat ${s.seatIndex} must have a positive integer stack, got ${s.stack}`);
    }
  }
  if (!Number.isInteger(buttonSeat) || buttonSeat < 0 || buttonSeat >= seatCount) {
    throw new Error(`buttonSeat ${buttonSeat} is outside a ${seatCount}-seat table`);
  }
  if (!seats.some((s) => s.seatIndex === buttonSeat)) {
    throw new Error(`buttonSeat ${buttonSeat} is not occupied`);
  }
  if (config.bigBlind <= 0 || config.smallBlind <= 0) {
    throw new Error('Blinds must be positive');
  }
  if (config.smallBlind > config.bigBlind) {
    throw new Error('Small blind cannot exceed the big blind');
  }
  if (config.ante < 0) throw new Error('Ante cannot be negative');
}

/**
 * Big-blind ante: the big blind posts a single ante for the table. A short
 * stack posts the ante first and the blind out of whatever survives, which is
 * the standard tournament convention and is what makes it possible to be
 * all-in for less than one blind.
 */
function postAntes(state: HandState, events: HandEvent[]): void {
  if (state.config.ante <= 0) return;
  const seat = seatAt(state, state.bigBlindSeat);
  const amount = Math.min(state.config.ante, seat.stack);
  if (amount <= 0) return;

  seat.stack -= amount;
  seat.totalCommitted += amount;
  seat.deadCommitted += amount;
  if (seat.stack === 0) seat.allIn = true;

  events.push({ type: 'ANTE_POSTED', seatIndex: seat.seatIndex, amount, allIn: seat.allIn });
}

function postBlinds(state: HandState, events: HandEvent[]): void {
  postBlind(state, events, state.smallBlindSeat, 'SMALL', state.config.smallBlind);
  postBlind(state, events, state.bigBlindSeat, 'BIG', state.config.bigBlind);
}

function postBlind(
  state: HandState,
  events: HandEvent[],
  seatIndex: number,
  blind: 'SMALL' | 'BIG',
  nominal: number,
): void {
  const seat = seatAt(state, seatIndex);
  const amount = Math.min(nominal, seat.stack);
  if (amount <= 0) return;
  commit(seat, amount);
  events.push({ type: 'BLIND_POSTED', seatIndex, blind, amount, allIn: seat.allIn });
}

/** One card at a time, twice around, starting to the left of the button. */
function dealHoleCards(state: HandState, events: HandEvent[]): void {
  const order = seatsClockwiseFrom(state, state.buttonSeat);
  const pending = new Map<number, Card[]>(order.map((s) => [s.seatIndex, []]));
  for (let round = 0; round < 2; round++) {
    for (const seat of order) pending.get(seat.seatIndex)!.push(draw(state.deck));
  }
  for (const seat of order) {
    const cards = pending.get(seat.seatIndex)!;
    seat.holeCards = [cards[0]!, cards[1]!];
  }
  events.push({ type: 'HOLE_CARDS_DEALT', seats: order.map((s) => s.seatIndex) });
}

// ---------------------------------------------------------------------------
// Legal actions
// ---------------------------------------------------------------------------

export function legalActions(state: HandState, seatIndex: number): LegalActions {
  const seat = seatAt(state, seatIndex);
  const toCall = Math.min(state.currentBet - seat.betThisRound, seat.stack);
  const maxRaiseTo = seat.betThisRound + seat.stack;

  // Raising is pointless and illegal once no opponent is left to answer it.
  const opponentsCanAct = state.seats.some(
    (s) => s.seatIndex !== seatIndex && !s.folded && !s.allIn,
  );
  const canRaise = seat.mayRaise && opponentsCanAct && maxRaiseTo > state.currentBet;
  const fullMinRaiseTo = state.currentBet + state.lastFullRaiseSize;
  const raiseIsAllInOnly = canRaise && maxRaiseTo < fullMinRaiseTo;

  return {
    seatIndex,
    currentBet: state.currentBet,
    betThisRound: seat.betThisRound,
    canFold: true,
    canCheck: toCall === 0,
    canCall: toCall > 0,
    callAmount: Math.max(0, toCall),
    canRaise,
    minRaiseTo: canRaise ? Math.min(fullMinRaiseTo, maxRaiseTo) : 0,
    maxRaiseTo: canRaise ? maxRaiseTo : 0,
    raiseIsAllInOnly,
    raiseActionType: state.currentBet === 0 ? 'BET' : 'RAISE',
  };
}

// ---------------------------------------------------------------------------
// Applying an action
// ---------------------------------------------------------------------------

export function applyAction(
  previous: HandState,
  seatIndex: number,
  action: PlayerAction,
): EngineStep {
  if (previous.phase === 'COMPLETE' || previous.phase === 'SHOWDOWN') {
    throw new IllegalActionError('The hand is over');
  }
  if (previous.actingSeat === null) {
    throw new IllegalActionError('No seat is being asked to act');
  }
  if (previous.actingSeat !== seatIndex) {
    throw new IllegalActionError(
      `It is seat ${previous.actingSeat}'s turn, not seat ${seatIndex}'s`,
    );
  }

  // Snapshot first: callers keep the old state, and a throw part-way through
  // validation can never leave a half-applied hand behind.
  const state = cloneState(previous);
  const seat = seatAt(state, seatIndex);
  const legal = legalActions(state, seatIndex);
  const resolved = resolveAction(state, seat, legal, action);

  const events: HandEvent[] = [];
  applyResolved(state, seat, resolved);
  events.push({
    type: 'PLAYER_ACTED',
    seatIndex,
    requested: action,
    action: resolved,
    stack: seat.stack,
    allIn: seat.allIn,
  });

  advance(state, events, seatIndex);
  return { state, events };
}

/** Turns the requested action into the concrete one, rejecting anything illegal. */
function resolveAction(
  state: HandState,
  seat: HandSeatState,
  legal: LegalActions,
  action: PlayerAction,
): ResolvedAction {
  switch (action.type) {
    case 'FOLD':
      return { type: 'FOLD' };

    case 'CHECK':
      if (!legal.canCheck) {
        throw new IllegalActionError(`Cannot check facing a bet of ${legal.callAmount}`);
      }
      return { type: 'CHECK' };

    case 'CALL':
      if (!legal.canCall) throw new IllegalActionError('There is nothing to call');
      return { type: 'CALL', amount: legal.callAmount };

    case 'ALL_IN': {
      const maxTo = seat.betThisRound + seat.stack;
      if (seat.stack <= 0) throw new IllegalActionError('Seat has no chips to commit');
      // Shoving is only a raise when raising is actually available; otherwise
      // the shove is just a call that happens to use the whole stack.
      if (!legal.canRaise || maxTo <= state.currentBet) {
        const amount = Math.min(state.currentBet - seat.betThisRound, seat.stack);
        if (amount <= 0) {
          throw new IllegalActionError('Cannot go all-in with nothing to call and no raise rights');
        }
        return { type: 'CALL', amount };
      }
      return state.currentBet === 0
        ? { type: 'BET', to: maxTo, amount: maxTo - seat.betThisRound }
        : { type: 'RAISE', to: maxTo, amount: maxTo - seat.betThisRound };
    }

    case 'BET':
    case 'RAISE': {
      const wantsBet = action.type === 'BET';
      if (wantsBet && state.currentBet !== 0) {
        throw new IllegalActionError('Cannot bet facing a bet; raise instead');
      }
      if (!wantsBet && state.currentBet === 0) {
        throw new IllegalActionError('Cannot raise with no bet outstanding; bet instead');
      }
      if (!legal.canRaise) throw new IllegalActionError('Raising is not available');

      const to = action.to;
      if (!Number.isInteger(to)) throw new IllegalActionError('Bet size must be a whole number');
      if (to > legal.maxRaiseTo) {
        throw new IllegalActionError(`Cannot commit ${to}; stack allows ${legal.maxRaiseTo}`);
      }
      if (to < legal.minRaiseTo) {
        throw new IllegalActionError(
          `Raise to ${to} is below the minimum of ${legal.minRaiseTo}`,
        );
      }
      const amount = to - seat.betThisRound;
      return wantsBet ? { type: 'BET', to, amount } : { type: 'RAISE', to, amount };
    }

    default: {
      const never: never = action;
      throw new IllegalActionError(`Unknown action ${JSON.stringify(never)}`);
    }
  }
}

function applyResolved(state: HandState, seat: HandSeatState, action: ResolvedAction): void {
  switch (action.type) {
    case 'FOLD':
      seat.folded = true;
      seat.hasActedThisRound = true;
      return;

    case 'CHECK':
      seat.hasActedThisRound = true;
      return;

    case 'CALL':
      commit(seat, action.amount);
      seat.hasActedThisRound = true;
      return;

    case 'BET':
    case 'RAISE': {
      const raiseSize = action.to - state.currentBet;
      const isFullRaise = raiseSize >= state.lastFullRaiseSize;
      commit(seat, action.amount);
      state.currentBet = action.to;
      if (isFullRaise) state.lastFullRaiseSize = raiseSize;

      for (const other of state.seats) {
        if (other === seat || other.folded || other.allIn) continue;
        if (isFullRaise) {
          // A legal full raise reopens the betting for everyone behind.
          other.hasActedThisRound = false;
          other.mayRaise = true;
        } else {
          // An all-in short of a full raise does not reopen the action for
          // anyone who already acted at this level: they may only call or fold.
          if (other.hasActedThisRound) other.mayRaise = false;
          other.hasActedThisRound = false;
        }
      }
      seat.hasActedThisRound = true;
      seat.mayRaise = true;
      return;
    }
  }
}

function commit(seat: HandSeatState, amount: number): void {
  if (amount < 0) throw new IllegalActionError('Cannot commit a negative amount');
  if (amount > seat.stack) throw new IllegalActionError('Cannot commit more than the stack');
  seat.stack -= amount;
  seat.betThisRound += amount;
  seat.totalCommitted += amount;
  if (seat.stack === 0) seat.allIn = true;
}

// ---------------------------------------------------------------------------
// Advancing the hand
// ---------------------------------------------------------------------------

/**
 * Moves the hand as far forward as it can go: to the next player owing an
 * action, or through the remaining streets to a result. `fromSeat` is the seat
 * the search for the next actor starts *after*.
 */
function advance(state: HandState, events: HandEvent[], fromSeat: number): void {
  let searchFrom = fromSeat;

  for (;;) {
    const contenders = state.seats.filter((s) => !s.folded);
    if (contenders.length === 1) {
      finishHand(state, events, false);
      return;
    }

    const canAct = contenders.filter((s) => !s.allIn);
    const allMatched = canAct.every((s) => s.betThisRound === state.currentBet);
    const everyoneActed = canAct.every((s) => s.hasActedThisRound);

    // With at most one player left able to act and nothing owed, there is no
    // betting to be had — the rest of the board just runs out.
    const roundClosed = allMatched && (canAct.length <= 1 || everyoneActed);

    if (!roundClosed) {
      const next = findNextActor(state, searchFrom);
      if (next === null) {
        throw new Error('Betting round is open but no seat can act — engine invariant broken');
      }
      state.actingSeat = next.seatIndex;
      events.push({
        type: 'ACTION_REQUIRED',
        seatIndex: next.seatIndex,
        legal: legalActions(state, next.seatIndex),
      });
      return;
    }

    events.push({
      type: 'BETTING_ROUND_CLOSED',
      phase: state.phase,
      potTotal: totalCommitted(state),
    });

    if (state.phase === 'RIVER') {
      finishHand(state, events, true);
      return;
    }

    dealNextStreet(state, events);
    // Post-flop action always opens to the left of the button.
    searchFrom = state.buttonSeat;
  }
}

function dealNextStreet(state: HandState, events: HandEvent[]): void {
  for (const seat of state.seats) {
    seat.betThisRound = 0;
    seat.hasActedThisRound = false;
    seat.mayRaise = true;
  }
  state.currentBet = 0;
  state.lastFullRaiseSize = state.config.bigBlind;
  state.actingSeat = null;

  const next: Record<'PREFLOP' | 'FLOP' | 'TURN', { phase: HandPhase; count: number }> = {
    PREFLOP: { phase: 'FLOP', count: 3 },
    FLOP: { phase: 'TURN', count: 1 },
    TURN: { phase: 'RIVER', count: 1 },
  };
  const step = next[state.phase as 'PREFLOP' | 'FLOP' | 'TURN'];
  if (!step) throw new Error(`Cannot deal a street after ${state.phase}`);

  state.burned.push(burn(state.deck));
  const cards = drawMany(state.deck, step.count);
  state.board.push(...cards);
  state.phase = step.phase;

  events.push({
    type: 'STREET_DEALT',
    street: step.phase as 'FLOP' | 'TURN' | 'RIVER',
    cards,
    board: [...state.board],
  });
}

/** The next seat clockwise from `fromSeat` that still owes an action. */
function findNextActor(state: HandState, fromSeat: number): HandSeatState | null {
  const ordered = seatsClockwiseFrom(state, fromSeat);
  for (const seat of ordered) {
    if (seat.folded || seat.allIn) continue;
    if (!seat.hasActedThisRound || seat.betThisRound !== state.currentBet) return seat;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

function finishHand(state: HandState, events: HandEvent[], showdown: boolean): void {
  state.actingSeat = null;
  state.phase = showdown ? 'SHOWDOWN' : 'COMPLETE';

  // `betThisRound` is street-scoped working state and the streets are over.
  // Clearing it keeps the finished hand coherent — otherwise returning an
  // uncalled bet could leave a seat showing more in front of it than it has
  // committed. Payouts read `totalCommitted`, so this changes no result.
  for (const seat of state.seats) seat.betThisRound = 0;

  const contenders = state.seats.filter((s) => !s.folded);

  const contributions: PotContribution[] = state.seats.map((s) => ({
    seatIndex: s.seatIndex,
    committed: s.totalCommitted,
    dead: s.deadCommitted,
    folded: s.folded,
  }));

  const layout = buildPots(contributions);

  if (layout.uncalledReturn) {
    const seat = seatAt(state, layout.uncalledReturn.seatIndex);
    seat.stack += layout.uncalledReturn.amount;
    // The chips never reached a pot, so they are no longer committed either.
    seat.totalCommitted -= layout.uncalledReturn.amount;
    if (seat.stack > 0) seat.allIn = false;
    events.push({
      type: 'UNCALLED_RETURNED',
      seatIndex: seat.seatIndex,
      amount: layout.uncalledReturn.amount,
    });
  }

  let reveals: ShowdownReveal[] | null = null;
  const rankBySeat = new Map<number, number>();

  if (showdown && contenders.length > 1) {
    reveals = contenders
      .map((seat) => {
        const hole = seat.holeCards!;
        const seven = [...hole, ...state.board];
        const rank = evaluate(seven);
        rankBySeat.set(seat.seatIndex, rank.score);
        return {
          seatIndex: seat.seatIndex,
          holeCards: hole,
          category: rank.category,
          score: rank.score,
          bestFive: bestFiveCards(seven),
        } satisfies ShowdownReveal;
      })
      .sort((a, b) => b.score - a.score || a.seatIndex - b.seatIndex);
    events.push({ type: 'SHOWDOWN', reveals });
  } else {
    // Won without a showdown: nobody has to show, and nobody gets to look.
    for (const seat of contenders) rankBySeat.set(seat.seatIndex, 0);
  }

  const awards = awardPots(layout.pots, rankBySeat, state.buttonSeat, state.seatCount);
  for (const award of awards) {
    seatAt(state, award.seatIndex).stack += award.amount;
    events.push({
      type: 'POT_AWARDED',
      potIndex: award.potIndex,
      seatIndex: award.seatIndex,
      amount: award.amount,
      oddChip: award.oddChip,
    });
  }

  const finalStacks: Record<number, number> = {};
  const netChange: Record<number, number> = {};
  for (const seat of state.seats) {
    finalStacks[seat.seatIndex] = seat.stack;
    netChange[seat.seatIndex] = seat.stack - seat.stackAtStart;
  }

  assertChipsConserved(state);

  const result: HandResult = {
    contenders: contenders.map((s) => s.seatIndex).sort((a, b) => a - b),
    showdown: reveals,
    uncalledReturn: layout.uncalledReturn,
    pots: layout.pots.map((p) => ({ amount: p.amount, eligibleSeats: [...p.eligibleSeats] })),
    awards,
    finalStacks,
    netChange,
  };

  state.result = result;
  state.phase = 'COMPLETE';
  events.push({ type: 'HAND_COMPLETE', result });
}

/**
 * The engine must never create or destroy a chip. This runs on every hand
 * rather than only in tests, because silently losing chips would corrupt a
 * match in a way players would experience as the game cheating.
 */
function assertChipsConserved(state: HandState): void {
  let before = 0;
  let after = 0;
  for (const seat of state.seats) {
    before += seat.stackAtStart;
    after += seat.stack;
  }
  if (before !== after) {
    throw new Error(`Chip conservation violated: ${before} chips in, ${after} chips out`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seatAt(state: HandState, seatIndex: number): HandSeatState {
  const seat = state.seats.find((s) => s.seatIndex === seatIndex);
  if (!seat) throw new IllegalActionError(`Seat ${seatIndex} is not in this hand`);
  return seat;
}

/** Occupied seats in clockwise order, starting *after* `fromSeat`. */
function seatsClockwiseFrom(state: HandState, fromSeat: number): HandSeatState[] {
  const out: HandSeatState[] = [];
  for (let step = 1; step <= state.seatCount; step++) {
    const index = (fromSeat + step) % state.seatCount;
    const seat = state.seats.find((s) => s.seatIndex === index);
    if (seat) out.push(seat);
  }
  return out;
}

function nextOccupiedSeat(occupied: readonly number[], fromSeat: number, seatCount: number): number {
  for (let step = 1; step <= seatCount; step++) {
    const index = (fromSeat + step) % seatCount;
    if (occupied.includes(index)) return index;
  }
  throw new Error('No occupied seat found');
}

export function totalCommitted(state: HandState): number {
  return state.seats.reduce((sum, s) => sum + s.totalCommitted, 0);
}

function cloneState(state: HandState): HandState {
  return structuredClone(state);
}
