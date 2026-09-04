import {
  levelAt,
  levelIndexForElapsed,
  startingStackFor,
  type BlindLevel,
  type BlindStructure,
  type PlayerAction,
} from '@cursed/shared';
import { applyAction, createHand } from './hand-engine.js';
import type { HandEvent } from '@cursed/shared';
import type { HandSeatInput, HandState } from './hand-state.js';
import { CryptoRandomSource, type RandomSource } from './random.js';

/**
 * The table: seats, stacks, the button, and the blind level.
 *
 * This is still pure poker. It knows how a tournament table behaves between
 * hands — who has chips, where the button goes next, which level is running —
 * and nothing else. Every supernatural system in the game plugs in at exactly
 * one place: the gap between `settleHand` and the next `startHand`, through the
 * explicit `grantChips` / `eliminate` operations below.
 *
 * That gap is the whole architecture. A sacrifice is chips arriving between
 * hands. A perk ritual is a pause between hands. Neither can reach inside a
 * hand, because there is no function here that lets them.
 */

export interface TableSeatState {
  seatIndex: number;
  playerId: string;
  stack: number;
  /** False once the player has left the table for good. The chair stays. */
  seated: boolean;
}

export type TableStatus = 'READY' | 'HAND_IN_PROGRESS' | 'AWAITING_SETTLEMENT' | 'FINISHED';

export interface TableState {
  seatCount: number;
  seats: TableSeatState[];
  buttonSeat: number;
  /** Number of hands dealt so far. The hand in progress is `handNumber`. */
  handNumber: number;
  structure: BlindStructure;
  levelIndex: number;
  status: TableStatus;
  hand: HandState | null;
}

export interface CreateTableOptions {
  seats: readonly { seatIndex: number; playerId: string; stack?: number }[];
  structure: BlindStructure;
  seatCount: number;
  /** Where the button sits for hand 1. Defaults to the lowest occupied seat. */
  buttonSeat?: number;
}

export function createTable(options: CreateTableOptions): TableState {
  const { structure, seatCount } = options;
  const startingStack = startingStackFor(structure);

  const seats: TableSeatState[] = [...options.seats]
    .sort((a, b) => a.seatIndex - b.seatIndex)
    .map((s) => ({
      seatIndex: s.seatIndex,
      playerId: s.playerId,
      stack: s.stack ?? startingStack,
      seated: true,
    }));

  if (seats.length < 2) throw new Error('A table needs at least two players');
  if (new Set(seats.map((s) => s.seatIndex)).size !== seats.length) {
    throw new Error('Duplicate seatIndex at the table');
  }
  for (const s of seats) {
    if (s.seatIndex < 0 || s.seatIndex >= seatCount) {
      throw new Error(`seatIndex ${s.seatIndex} is outside a ${seatCount}-seat table`);
    }
  }

  const buttonSeat = options.buttonSeat ?? seats[0]!.seatIndex;
  if (!seats.some((s) => s.seatIndex === buttonSeat)) {
    throw new Error(`buttonSeat ${buttonSeat} is not occupied`);
  }

  return {
    seatCount,
    seats,
    buttonSeat,
    handNumber: 0,
    structure,
    levelIndex: 0,
    status: 'READY',
    hand: null,
  };
}

// ---------------------------------------------------------------------------
// Between hands
// ---------------------------------------------------------------------------

/** Seats that can be dealt into the next hand: seated, with chips. */
export function contestingSeats(table: TableState): TableSeatState[] {
  return table.seats.filter((s) => s.seated && s.stack > 0);
}

/** Seated players who have no chips — the ones a sacrifice window is for. */
export function bustedSeats(table: TableState): TableSeatState[] {
  return table.seats.filter((s) => s.seated && s.stack <= 0);
}

export function currentLevel(table: TableState): BlindLevel {
  return levelAt(table.structure, table.levelIndex);
}

/**
 * Moves to the level matching elapsed match time. Only legal between hands: a
 * hand always finishes at the blinds it started with.
 */
export function setLevelFromElapsed(table: TableState, elapsedSeconds: number): TableState {
  requireBetweenHands(table, 'change the blind level');
  const levelIndex = levelIndexForElapsed(table.structure, elapsedSeconds);
  return levelIndex === table.levelIndex ? table : { ...table, levelIndex };
}

export function setLevelIndex(table: TableState, levelIndex: number): TableState {
  requireBetweenHands(table, 'change the blind level');
  return { ...table, levelIndex };
}

/**
 * Adds chips to a seat between hands.
 *
 * This is the *only* way chips enter the table from outside a pot, and it is
 * how a sacrifice rebuy is applied. The poker layer deliberately does not ask
 * why: it takes an amount and a reason string for the log, and that is all it
 * ever needs to know about the supernatural.
 */
export function grantChips(
  table: TableState,
  seatIndex: number,
  amount: number,
  reason: string,
): TableState {
  requireBetweenHands(table, 'grant chips');
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`Chip grant must be a positive integer, got ${amount}`);
  }
  const seat = table.seats.find((s) => s.seatIndex === seatIndex);
  if (!seat) throw new Error(`No seat ${seatIndex}`);
  if (!seat.seated) throw new Error(`Seat ${seatIndex} has left the table`);
  void reason; // carried by the caller's own event log, not the poker state

  return {
    ...table,
    seats: table.seats.map((s) => (s.seatIndex === seatIndex ? { ...s, stack: s.stack + amount } : s)),
  };
}

/** Removes a player for good. Their chair stays in `seats`, marked unseated. */
export function eliminate(table: TableState, seatIndex: number): TableState {
  requireBetweenHands(table, 'eliminate a player');
  const seat = table.seats.find((s) => s.seatIndex === seatIndex);
  if (!seat) throw new Error(`No seat ${seatIndex}`);
  if (seat.stack > 0) throw new Error(`Seat ${seatIndex} still has ${seat.stack} chips`);

  const seats = table.seats.map((s) => (s.seatIndex === seatIndex ? { ...s, seated: false } : s));
  const remaining = seats.filter((s) => s.seated);
  return {
    ...table,
    seats,
    status: remaining.length <= 1 ? 'FINISHED' : table.status,
  };
}

/**
 * The next button seat.
 *
 * The button advances to the next seat still holding chips. Because the blinds
 * are derived from the button, this makes the big blind move forward by exactly
 * one contesting seat each hand, so nobody ever posts it twice in a row. It is
 * a deliberate simplification of the live dead-button rule: a player can be
 * skipped for a big blind after an elimination, which costs them nothing.
 */
export function nextButtonSeat(table: TableState): number {
  const eligible = contestingSeats(table).map((s) => s.seatIndex);
  if (eligible.length === 0) throw new Error('No seats left to take the button');
  for (let step = 1; step <= table.seatCount; step++) {
    const index = (table.buttonSeat + step) % table.seatCount;
    if (eligible.includes(index)) return index;
  }
  throw new Error('No seats left to take the button');
}

// ---------------------------------------------------------------------------
// Running a hand
// ---------------------------------------------------------------------------

export interface TableStep {
  table: TableState;
  events: HandEvent[];
}

export function startHand(table: TableState, rng: RandomSource = new CryptoRandomSource()): TableStep {
  requireBetweenHands(table, 'start a hand');
  if (table.status === 'FINISHED') throw new Error('The match is over');

  const contesting = contestingSeats(table);
  if (contesting.length < 2) {
    throw new Error(`Need at least two players with chips, have ${contesting.length}`);
  }

  // The button never sits on a seat that is out of the hand.
  const buttonSeat = contesting.some((s) => s.seatIndex === table.buttonSeat)
    ? table.buttonSeat
    : nextButtonSeat(table);

  const level = currentLevel(table);
  const handSeats: HandSeatInput[] = contesting.map((s) => ({
    seatIndex: s.seatIndex,
    playerId: s.playerId,
    stack: s.stack,
  }));

  const { state, events } = createHand({
    handNumber: table.handNumber + 1,
    seats: handSeats,
    buttonSeat,
    seatCount: table.seatCount,
    config: { smallBlind: level.smallBlind, bigBlind: level.bigBlind, ante: level.ante },
    rng,
  });

  // A hand can be over before anyone acts: if every stack is swallowed by the
  // blinds and antes, the board just runs out.
  const status: TableStatus =
    state.phase === 'COMPLETE' ? 'AWAITING_SETTLEMENT' : 'HAND_IN_PROGRESS';

  return {
    table: {
      ...table,
      buttonSeat,
      handNumber: table.handNumber + 1,
      status,
      hand: state,
    },
    events,
  };
}

export function act(table: TableState, seatIndex: number, action: PlayerAction): TableStep {
  if (table.status !== 'HAND_IN_PROGRESS' || !table.hand) {
    throw new Error('No hand is in progress');
  }
  const { state, events } = applyAction(table.hand, seatIndex, action);
  const status: TableStatus = state.phase === 'COMPLETE' ? 'AWAITING_SETTLEMENT' : 'HAND_IN_PROGRESS';
  return { table: { ...table, hand: state, status }, events };
}

export interface HandSettlement {
  handNumber: number;
  /** Seats that finished the hand with nothing. Candidates for a sacrifice. */
  busted: number[];
  /** Net chip change per seat. */
  netChange: Record<number, number>;
  /** Where the button will sit next, given who still has chips. */
  nextButtonSeat: number | null;
}

/**
 * Writes the finished hand's stacks back to the table and moves the button.
 *
 * It deliberately does *not* eliminate anyone. Busted seats are only reported;
 * whether they leave, sacrifice, or sit there bleeding is somebody else's
 * decision, taken between hands.
 */
export function settleHand(table: TableState): { table: TableState; settlement: HandSettlement } {
  if (table.status !== 'AWAITING_SETTLEMENT' || !table.hand?.result) {
    throw new Error('There is no finished hand to settle');
  }
  const { hand } = table;
  const result = hand.result!;

  const seats = table.seats.map((s) => {
    const finalStack = result.finalStacks[s.seatIndex];
    return finalStack === undefined ? s : { ...s, stack: finalStack };
  });

  const before = table.seats.reduce((sum, s) => sum + s.stack, 0);
  const after = seats.reduce((sum, s) => sum + s.stack, 0);
  if (before !== after) {
    throw new Error(`Table lost chips settling hand ${hand.handNumber}: ${before} -> ${after}`);
  }

  const settled: TableState = {
    ...table,
    seats,
    status: 'READY',
    hand: null,
  };

  const stillIn = contestingSeats(settled);
  const busted = seats
    .filter((s) => s.seated && s.stack <= 0)
    .map((s) => s.seatIndex)
    .sort((a, b) => a - b);

  const nextButton = stillIn.length >= 1 ? nextButtonSeat(settled) : null;

  return {
    table: nextButton === null ? settled : { ...settled, buttonSeat: nextButton },
    settlement: {
      handNumber: hand.handNumber,
      busted,
      netChange: result.netChange,
      nextButtonSeat: nextButton,
    },
  };
}

function requireBetweenHands(table: TableState, what: string): void {
  if (table.status === 'HAND_IN_PROGRESS' || table.status === 'AWAITING_SETTLEMENT') {
    throw new Error(`Cannot ${what} while a hand is in progress`);
  }
}
