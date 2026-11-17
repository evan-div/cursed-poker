import { describe, expect, it } from 'vitest';
import type { BlindStructure, MatchEvent, PlayerAction, StressEvent } from '@cursed/shared';
import { SeededRandomSource } from '../poker/index.js';
import { ManualClock } from './clock.js';
import { Match } from './match.js';
import { splitRunout } from './runout.js';

/**
 * An all-in runout, a street at a time.
 *
 * When nobody left in a hand can bet, the engine deals the rest of the board in
 * one step: it is a pure function and has nobody to wait for. Sent to the table
 * like that, the most dramatic moment in poker is over in a frame. So the match
 * holds the result back and lets it out a street at a time.
 *
 * It is presentation, and these tests are mostly about keeping it *only*
 * presentation: the poker has already happened, nothing about it changes, and
 * nothing — not a card, not a stack, not somebody's hands starting to shake —
 * tells the table how it ends before the last card is down.
 */

const TIMINGS = {
  actionTimeoutMs: 30_000,
  disconnectedActionTimeoutMs: 5_000,
  showdownDisplayMs: 400,
  foldedHandDisplayMs: 100,
  betweenHandsMs: 100,
  runoutRevealMs: 1_000,
  runoutStreetMs: 1_000,
  runoutSettleMs: 500,
};

const stacks = (bigBlinds: number): BlindStructure => ({
  id: 'runout',
  label: 'Runout',
  startingStackBigBlinds: bigBlinds,
  levels: [{ level: 1, smallBlind: 50, bigBlind: 100, ante: 0, durationSeconds: 36_000 }],
});

function table(options: { bigBlinds?: number; seed?: number } = {}) {
  const clock = new ManualClock();
  const events: MatchEvent[] = [];
  const felt: { seatIndex: number; event: StressEvent }[] = [];
  const match = new Match({
    roomCode: 'RUNOUT',
    hostPlayerId: 'p0',
    clock,
    rng: new SeededRandomSource(options.seed ?? 3),
    structure: stacks(options.bigBlinds ?? 20),
    timings: TIMINGS,
    telemetry: {
      event: (_now, seatIndex, event) => void felt.push({ seatIndex, event }),
      settled: () => {},
      forgot: () => {},
    },
  });
  match.onUpdate((batch) => events.push(...batch));
  const ids = ['p0', 'p1', 'p2', 'p3'];
  for (const id of ids) match.join(id, id);
  for (const id of ids) match.setReady(id, true);
  match.start('p0');

  const act = (action: PlayerAction): void => {
    const hand = match.state.table!.hand!;
    const actor = match.state.players.find((p) => p.seatIndex === hand.actingSeat)!;
    match.submitAction(actor.playerId, hand.handNumber, action);
  };
  const types = () => events.map((event) => event.type);
  const view = (id = 'p0') => match.viewFor(id);
  return { match, clock, events, felt, act, types, view, ids };
}

/** Everybody shoves before the flop: the longest runout there is. */
function allInBeforeTheFlop(h: ReturnType<typeof table>): void {
  for (let i = 0; i < 4; i++) h.act({ type: 'ALL_IN' });
}

describe('an all-in runout', () => {
  it('shows the hands, and none of the board, the moment the betting is over', () => {
    const h = table();
    allInBeforeTheFlop(h);

    const hand = h.view().hand!;
    expect(hand.allInRunout).toBe(true);
    expect(hand.board).toEqual([]);
    expect(hand.phase).toBe('PREFLOP');
    expect(hand.actingSeat).toBeNull();
    // Tabled, as they would be anywhere: nobody can bet, so nobody has anything
    // left to hide. But what the hands *are worth* is not said yet.
    for (const seat of hand.seats) {
      expect(seat.revealedCards).toHaveLength(2);
      expect(seat.handCategory).toBeNull();
      expect(seat.bestFive).toBeNull();
    }
    expect(h.types()).toContain('ALL_IN_SHOWDOWN');
  });

  it('has already been played: staging it changes nothing about the poker', () => {
    const h = table();
    allInBeforeTheFlop(h);
    // The engine finished the hand in the same step as the last call. What
    // follows is the telling of it.
    const hand = h.match.state.table!.hand!;
    expect(hand.phase).toBe('COMPLETE');
    expect(hand.board).toHaveLength(5);
    const decided = structuredClone(hand.result);
    const board = [...hand.board];

    h.clock.advance(10_000);
    const told = h.events.find((event) => event.type === 'HAND_COMPLETE');
    expect(told && told.type === 'HAND_COMPLETE' && told.result).toEqual(decided);
    const streets = h.events.filter((event) => event.type === 'STREET_DEALT');
    expect(streets.at(-1)).toMatchObject({ street: 'RIVER', board });
  });

  it('deals the board a street at a time, to everybody at once', () => {
    const h = table();
    allInBeforeTheFlop(h);
    const full = [...h.match.state.table!.hand!.board];

    const seen: number[] = [];
    for (let step = 0; step < 12 && h.view().hand?.allInRunout; step++) {
      const boards = h.ids.map((id) => h.view(id).hand!.board);
      // Nobody is ahead of anybody else, and nobody sees a card out of order.
      for (const board of boards) expect(board).toEqual(boards[0]);
      expect(boards[0]).toEqual(full.slice(0, boards[0]!.length));
      seen.push(boards[0]!.length);
      h.clock.advance(500);
    }
    expect([...new Set(seen)]).toEqual([0, 3, 4, 5]);
    // Each one stayed on the table long enough to be looked at.
    for (const count of [0, 3, 4]) expect(seen.filter((n) => n === count).length).toBeGreaterThanOrEqual(2);
  });

  it('names the street it is on while it runs', () => {
    const h = table();
    allInBeforeTheFlop(h);
    const phases: string[] = [];
    for (let step = 0; step < 12 && h.view().hand?.allInRunout; step++) {
      phases.push(h.view().hand!.phase);
      h.clock.advance(500);
    }
    expect([...new Set(phases)]).toEqual(['PREFLOP', 'FLOP', 'TURN', 'RIVER']);
  });

  it('keeps the money where it was until the last card is down', () => {
    const h = table();
    allInBeforeTheFlop(h);
    const pot = h.view().hand!.potTotal;

    while (h.view().hand?.allInRunout) {
      const hand = h.view().hand!;
      // A winner's stack arriving early would be the ending, in a number.
      for (const seat of hand.seats) expect(seat.stack).toBe(0);
      expect(hand.potTotal).toBe(pot);
      expect(h.view().lastResult).toBeNull();
      expect(h.types()).not.toContain('POT_AWARDED');
      expect(h.types()).not.toContain('SHOWDOWN');
      expect(h.types()).not.toContain('HAND_COMPLETE');
      h.clock.advance(250);
    }
    expect(h.types()).toContain('HAND_COMPLETE');
    expect(h.view().lastResult).not.toBeNull();
    const total = h.view().hand!.seats.reduce((sum, seat) => sum + seat.stack, 0);
    expect(total).toBe(pot);
  });

  it('lets nobody feel the result before they have seen it', () => {
    // Tells are broadcast. A winner who relaxed, or a loser whose hands began
    // to shake, while the turn was still face down would be the river read off
    // somebody's body.
    const h = table();
    allInBeforeTheFlop(h);
    const outcome = (name: StressEvent) => name === 'WON_POT' || name === 'LOST_POT';
    while (h.view().hand?.allInRunout) {
      h.match.tick();
      expect(h.felt.filter((f) => outcome(f.event))).toEqual([]);
      h.clock.advance(250);
    }
    expect(h.felt.some((f) => outcome(f.event))).toBe(true);
  });

  it('says how the hands rank only at the end', () => {
    const h = table();
    allInBeforeTheFlop(h);
    // Hands over, flop; then turn; then river; then the beat before the verdict.
    h.clock.advance(TIMINGS.runoutRevealMs + TIMINGS.runoutStreetMs * 2 + TIMINGS.runoutSettleMs + 50);
    const hand = h.view().hand!;
    expect(hand.allInRunout).toBe(false);
    expect(hand.board).toHaveLength(5);
    for (const seat of hand.seats) expect(seat.handCategory).not.toBeNull();
  });

  it('takes no action while it runs, and moves on by itself afterwards', () => {
    const h = table();
    allInBeforeTheFlop(h);
    const first = h.match.state.table!.hand!.handNumber;
    expect(() => h.match.submitAction('p0', first, { type: 'FOLD' })).toThrow();
    h.clock.advance(30_000);
    const state = h.match.state;
    expect(state.status === 'FINISHED' || state.table!.handNumber > first).toBe(true);
    expect(state.runout).toBeNull();
  });

  it('runs out only what is left: one card after an all-in on the turn', () => {
    const h = table({ bigBlinds: 20 });
    // Limp round, then check the flop down.
    h.act({ type: 'CALL' });
    h.act({ type: 'CALL' });
    h.act({ type: 'CALL' });
    h.act({ type: 'CHECK' });
    for (let i = 0; i < 4; i++) h.act({ type: 'CHECK' });
    expect(h.match.state.table!.hand!.phase).toBe('TURN');
    // One shoves the turn, one calls, two fold.
    h.act({ type: 'ALL_IN' });
    h.act({ type: 'CALL' });
    h.act({ type: 'FOLD' });
    h.act({ type: 'FOLD' });

    const hand = h.view().hand!;
    expect(hand.allInRunout).toBe(true);
    expect(hand.board).toHaveLength(4);
    // Only the two still in it show.
    expect(hand.seats.filter((seat) => seat.revealedCards !== null)).toHaveLength(2);
    expect(hand.seats.filter((seat) => seat.folded).every((seat) => seat.revealedCards === null)).toBe(true);

    h.clock.advance(TIMINGS.runoutRevealMs + 50);
    expect(h.view().hand!.board).toHaveLength(5);
  });

  it('is not staged when there was nothing left to run out', () => {
    const h = table();
    // Checked down to a showdown on the river, the ordinary way.
    h.act({ type: 'CALL' });
    h.act({ type: 'CALL' });
    h.act({ type: 'CALL' });
    h.act({ type: 'CHECK' });
    for (let street = 0; street < 3; street++) for (let i = 0; i < 4; i++) h.act({ type: 'CHECK' });

    expect(h.types()).toContain('SHOWDOWN');
    expect(h.types()).not.toContain('ALL_IN_SHOWDOWN');
    expect(h.view().hand!.allInRunout).toBe(false);
    expect(h.match.state.runout).toBeNull();
  });

  it('is not staged when everybody but one folds', () => {
    const h = table();
    h.act({ type: 'ALL_IN' });
    h.act({ type: 'FOLD' });
    h.act({ type: 'FOLD' });
    h.act({ type: 'FOLD' });
    expect(h.types()).not.toContain('ALL_IN_SHOWDOWN');
    expect(h.view().hand!.seats.every((seat) => seat.revealedCards === null)).toBe(true);
  });

  it('stops with the match if the room is thrown away mid-runout', () => {
    const h = table();
    allInBeforeTheFlop(h);
    const before = h.events.length;
    h.match.dispose();
    expect(() => h.clock.advance(30_000)).not.toThrow();
    expect(h.events.length).toBe(before);
  });
});

describe('cutting a finished hand into acts', () => {
  const street = (name: 'FLOP' | 'TURN' | 'RIVER'): MatchEvent => ({ type: 'STREET_DEALT', street: name, cards: [], board: [] });
  const closed: MatchEvent = { type: 'BETTING_ROUND_CLOSED', phase: 'PREFLOP', potTotal: 0 };
  const showdown: MatchEvent = { type: 'SHOWDOWN', reveals: [] };
  const complete = { type: 'HAND_COMPLETE', result: {} } as unknown as MatchEvent;
  const acted = { type: 'PLAYER_ACTED' } as unknown as MatchEvent;
  const returned: MatchEvent = { type: 'UNCALLED_RETURNED', seatIndex: 1, amount: 50 };

  it('leaves alone a hand with nothing to run out', () => {
    expect(splitRunout([acted, closed, showdown, complete])).toBeNull();
    expect(splitRunout([acted, complete])).toBeNull();
    // A street dealt with betting still to come is not a runout either.
    expect(splitRunout([acted, closed, street('FLOP'), { type: 'ACTION_REQUIRED' } as unknown as MatchEvent])).toBeNull();
  });

  it('gives each street its own act, and keeps the ending for last', () => {
    const acts = splitRunout([acted, closed, street('FLOP'), closed, street('TURN'), closed, street('RIVER'), closed, showdown, complete])!;
    expect(acts.opening.map((e) => e.type)).toEqual(['PLAYER_ACTED', 'BETTING_ROUND_CLOSED']);
    expect(acts.streets.map((act) => act[0]!.type)).toEqual(['STREET_DEALT', 'STREET_DEALT', 'STREET_DEALT']);
    expect(acts.closing.map((e) => e.type)).toEqual(['SHOWDOWN', 'HAND_COMPLETE']);
  });

  it('tells of chips coming back at the start, when they came back', () => {
    // An uncalled bet is returned the moment nobody can call it, not after
    // the river — and the stacks on screen already say so.
    const acts = splitRunout([acted, closed, street('RIVER'), closed, returned, showdown, complete])!;
    expect(acts.opening.map((e) => e.type)).toContain('UNCALLED_RETURNED');
    expect(acts.closing.map((e) => e.type)).not.toContain('UNCALLED_RETURNED');
  });

  it('loses nothing and repeats nothing', () => {
    const events = [acted, closed, street('FLOP'), closed, street('TURN'), closed, street('RIVER'), closed, returned, showdown, complete];
    const acts = splitRunout(events)!;
    const all = [...acts.opening, ...acts.streets.flat(), ...acts.closing];
    expect(all).toHaveLength(events.length);
    for (const event of events) expect(all).toContain(event);
  });
});
