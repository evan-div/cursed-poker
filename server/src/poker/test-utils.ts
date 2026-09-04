/**
 * Helpers for driving hands deterministically in tests. Nothing here is
 * reachable from a real match: stacked decks exist only so that a test can
 * describe an exact situation instead of hoping to shuffle into one.
 */
import { cardsFromString, orderedDeck, type Card, type PlayerAction } from '@cursed/shared';
import { stackedDeck, type SecretDeck } from './deck.js';
import { applyAction, createHand, legalActions, type CreateHandOptions } from './hand-engine.js';
import type { HandEvent } from '@cursed/shared';
import type { HandSeatInput, HandState } from './hand-state.js';

/** Occupied seats in clockwise order starting after the button — the deal order. */
export function dealOrder(seats: readonly number[], buttonSeat: number, seatCount: number) {
  const out: number[] = [];
  for (let step = 1; step <= seatCount; step++) {
    const index = (buttonSeat + step) % seatCount;
    if (seats.includes(index)) out.push(index);
  }
  return out;
}

/**
 * Builds a deck that deals the requested hole cards and board.
 *
 * Mirrors the engine's dealing order exactly: one card at a time twice around
 * starting left of the button, then burn/flop, burn/turn, burn/river.
 */
export function stackDeckFor(options: {
  seats: readonly number[];
  buttonSeat: number;
  seatCount: number;
  hole: Record<number, string>;
  board?: string;
}): SecretDeck {
  const order = dealOrder(options.seats, options.buttonSeat, options.seatCount);
  const hole = new Map<number, Card[]>();
  for (const seat of order) {
    const text = options.hole[seat];
    if (!text) throw new Error(`test setup: no hole cards for seat ${seat}`);
    const cards = cardsFromString(text);
    if (cards.length !== 2) throw new Error(`test setup: seat ${seat} needs exactly 2 cards`);
    hole.set(seat, cards);
  }

  const board = options.board ? cardsFromString(options.board) : [];
  if (board.length > 5) throw new Error('test setup: board cannot exceed 5 cards');

  const used = new Set<Card>([...[...hole.values()].flat(), ...board]);
  const spare = orderedDeck().filter((c) => !used.has(c));
  const nextSpare = () => {
    const card = spare.shift();
    if (card === undefined) throw new Error('test setup: ran out of spare cards');
    return card;
  };

  const cards: Card[] = [];
  for (let round = 0; round < 2; round++) {
    for (const seat of order) cards.push(hole.get(seat)![round]!);
  }
  const boardOrSpare = (i: number) => board[i] ?? nextSpare();
  cards.push(nextSpare(), boardOrSpare(0), boardOrSpare(1), boardOrSpare(2)); // burn + flop
  cards.push(nextSpare(), boardOrSpare(3)); // burn + turn
  cards.push(nextSpare(), boardOrSpare(4)); // burn + river
  cards.push(...spare);

  return stackedDeck(cards);
}

export interface HandDriverOptions extends Omit<CreateHandOptions, 'seats' | 'deck'> {
  seats: readonly HandSeatInput[];
  hole?: Record<number, string>;
  board?: string;
}

/** Thin wrapper that keeps the latest state and the full event log. */
export class HandDriver {
  state: HandState;
  events: HandEvent[] = [];

  constructor(options: HandDriverOptions) {
    const deck =
      options.hole &&
      stackDeckFor({
        seats: options.seats.map((s) => s.seatIndex),
        buttonSeat: options.buttonSeat,
        seatCount: options.seatCount,
        hole: options.hole,
        ...(options.board !== undefined ? { board: options.board } : {}),
      });

    const step = createHand({ ...options, ...(deck ? { deck } : {}) });
    this.state = step.state;
    this.events.push(...step.events);
  }

  get acting(): number | null {
    return this.state.actingSeat;
  }

  legal(seatIndex = this.state.actingSeat!) {
    return legalActions(this.state, seatIndex);
  }

  /** Applies an action for whoever is due to act, unless a seat is named. */
  act(action: PlayerAction, seatIndex = this.state.actingSeat!): this {
    const step = applyAction(this.state, seatIndex, action);
    this.state = step.state;
    this.events.push(...step.events);
    return this;
  }

  stack(seatIndex: number): number {
    const seat = this.state.seats.find((s) => s.seatIndex === seatIndex);
    if (!seat) throw new Error(`No seat ${seatIndex}`);
    return seat.stack;
  }

  eventsOfType<T extends HandEvent['type']>(type: T): Extract<HandEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<HandEvent, { type: T }>[];
  }
}

export function seats(...entries: [seatIndex: number, stack: number][]): HandSeatInput[] {
  return entries.map(([seatIndex, stack]) => ({
    seatIndex,
    playerId: `p${seatIndex}`,
    stack,
  }));
}
