import { describe, expect, it } from 'vitest';
import { DEFAULT_BLIND_STRUCTURE, type PlayerAction, type LegalActions } from '@cursed/shared';
import {
  act,
  contestingSeats,
  createTable,
  eliminate,
  legalActions,
  settleHand,
  startHand,
  evaluateReference,
  SeededRandomSource,
  type HandState,
  type TableState,
} from '../server/src/poker/index.js';

/**
 * Whole-match fuzzing.
 *
 * Random players hammer the engine through thousands of complete matches while
 * every invariant that makes poker trustworthy is checked after every single
 * action. If any of these ever fail, the game is cheating — which is the one
 * thing this project is not allowed to do.
 */

function chooseAction(legal: LegalActions, potSize: number, rng: SeededRandomSource): PlayerAction {
  const roll = rng.nextInt(100);
  const aggressive = (): PlayerAction =>
    legal.raiseActionType === 'BET'
      ? { type: 'BET', to: pickSize(legal, potSize, rng) }
      : { type: 'RAISE', to: pickSize(legal, potSize, rng) };

  if (legal.canCheck) {
    if (roll < 55) return { type: 'CHECK' };
    if (roll < 60) return { type: 'FOLD' };
    if (roll < 97 && legal.canRaise) return aggressive();
    if (legal.canRaise) return { type: 'ALL_IN' };
    return { type: 'CHECK' };
  }

  if (roll < 30) return { type: 'FOLD' };
  if (roll < 80) return { type: 'CALL' };
  if (roll < 97 && legal.canRaise) return aggressive();
  if (legal.canRaise || legal.canCall) return { type: 'ALL_IN' };
  return { type: 'FOLD' };
}

function pickSize(legal: LegalActions, potSize: number, rng: SeededRandomSource): number {
  const low = legal.minRaiseTo;
  const high = Math.min(legal.maxRaiseTo, Math.max(low, potSize + legal.callAmount * 2));
  if (high <= low) return low;
  return low + rng.nextInt(high - low + 1);
}

function assertHandInvariants(hand: HandState): void {
  let committed = 0;
  let stacks = 0;
  let opening = 0;

  for (const seat of hand.seats) {
    expect(seat.stack).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(seat.stack)).toBe(true);
    expect(seat.betThisRound).toBeGreaterThanOrEqual(0);
    expect(seat.betThisRound).toBeLessThanOrEqual(seat.totalCommitted);

    if (hand.phase !== 'COMPLETE') {
      // While the hand is live, having no chips left means being all-in, and
      // nobody can have more in front of them than the bet being matched.
      expect(seat.allIn).toBe(seat.stack === 0);
      expect(seat.betThisRound).toBeLessThanOrEqual(hand.currentBet);
    }

    committed += seat.totalCommitted;
    stacks += seat.stack;
    opening += seat.stackAtStart;
  }

  if (hand.phase !== 'COMPLETE') {
    expect(stacks + committed).toBe(opening);
  } else {
    expect(stacks).toBe(opening);
  }

  if (hand.actingSeat !== null) {
    const seat = hand.seats.find((s) => s.seatIndex === hand.actingSeat)!;
    expect(seat.folded).toBe(false);
    expect(seat.allIn).toBe(false);
    expect(hand.phase).not.toBe('COMPLETE');
  }

  const expectedBoard: Record<string, number | null> = {
    PREFLOP: 0,
    FLOP: 3,
    TURN: 4,
    RIVER: 5,
    SHOWDOWN: 5,
    COMPLETE: null, // a hand can end on any street
  };
  const expected = expectedBoard[hand.phase];
  if (expected === null) expect(hand.board.length).toBeLessThanOrEqual(5);
  else expect(hand.board.length).toBe(expected);

  // Every card in play is distinct.
  const dealt = [...hand.board, ...hand.burned, ...hand.seats.flatMap((s) => s.holeCards ?? [])];
  expect(new Set(dealt).size).toBe(dealt.length);
}

function assertResultInvariants(hand: HandState): void {
  const result = hand.result;
  expect(result).not.toBeNull();
  if (!result) return;

  const potTotal = result.pots.reduce((sum, p) => sum + p.amount, 0);
  const awarded = result.awards.reduce((sum, a) => sum + a.amount, 0);
  const stillCommitted = hand.seats.reduce((sum, s) => sum + s.totalCommitted, 0);

  // Every chip that went in came back out: pots are fully paid, the chips
  // backing them are exactly what players committed once the uncalled part was
  // handed back, and the hand is zero-sum.
  expect(awarded).toBe(potTotal);
  expect(stillCommitted).toBe(potTotal);
  expect(Object.values(result.netChange).reduce((a, b) => a + b, 0)).toBe(0);

  // A pot may only be won by someone eligible for it.
  const eligibleByPot = result.pots.map((p) => new Set(p.eligibleSeats));
  for (const award of result.awards) {
    expect(eligibleByPot[award.potIndex]!.has(award.seatIndex)).toBe(true);
  }

  if (!result.showdown) return;

  // The declared winner of each pot really does hold the best hand among the
  // seats eligible for it — checked with the slow reference evaluator, not the
  // one the engine used.
  for (const [potIndex, pot] of result.pots.entries()) {
    const winners = result.awards.filter((a) => a.potIndex === potIndex).map((a) => a.seatIndex);
    if (winners.length === 0) continue;

    const scores = new Map<number, number>();
    for (const seatIndex of pot.eligibleSeats) {
      const seat = hand.seats.find((s) => s.seatIndex === seatIndex)!;
      if (seat.folded || !seat.holeCards) continue;
      scores.set(seatIndex, evaluateReference([...seat.holeCards, ...hand.board]).score);
    }
    const best = Math.max(...scores.values());
    for (const winner of winners) expect(scores.get(winner)).toBe(best);
  }
}

/** Plays one match to a single survivor. Returns how many hands it took. */
function playMatch(playerCount: number, seed: number): { hands: number; survivors: number } {
  const rng = new SeededRandomSource(seed);
  let table: TableState = createTable({
    seats: Array.from({ length: playerCount }, (_, i) => ({ seatIndex: i, playerId: `p${i}` })),
    structure: DEFAULT_BLIND_STRUCTURE,
    seatCount: 6,
  });

  const openingChips = table.seats.reduce((sum, s) => sum + s.stack, 0);
  let hands = 0;

  while (contestingSeats(table).length >= 2 && hands < 5_000) {
    // Blinds climb on a fixed cadence so long matches cannot stall forever.
    table = { ...table, levelIndex: Math.min(Math.floor(hands / 25), DEFAULT_BLIND_STRUCTURE.levels.length - 1) };

    table = startHand(table, rng).table;
    hands++;

    let guard = 0;
    while (table.hand && table.hand.actingSeat !== null) {
      if (guard++ > 500) throw new Error('Hand did not terminate');
      const seatIndex = table.hand.actingSeat;
      const legal = legalActions(table.hand, seatIndex);
      const pot = table.hand.seats.reduce((sum, s) => sum + s.totalCommitted, 0);
      table = act(table, seatIndex, chooseAction(legal, pot, rng)).table;
      assertHandInvariants(table.hand!);
    }

    assertHandInvariants(table.hand!);
    assertResultInvariants(table.hand!);

    table = settleHand(table).table;
    expect(table.seats.reduce((sum, s) => sum + s.stack, 0)).toBe(openingChips);

    // No sacrifices in this simulation: a bust is an immediate elimination.
    for (const seat of table.seats.filter((s) => s.seated && s.stack <= 0)) {
      table = eliminate(table, seat.seatIndex);
    }
  }

  return { hands, survivors: contestingSeats(table).length };
}

describe('full match fuzzing', () => {
  it('plays 4-handed matches to a single survivor without breaking an invariant', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { survivors } = playMatch(4, seed * 31);
      expect(survivors).toBe(1);
    }
  });

  it('plays 5-handed matches to a single survivor', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { survivors } = playMatch(5, seed * 97);
      expect(survivors).toBe(1);
    }
  });

  it('plays 6-handed matches to a single survivor', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { survivors } = playMatch(6, seed * 17);
      expect(survivors).toBe(1);
    }
  });

  it('always leaves exactly one player holding every chip', () => {
    const rng = new SeededRandomSource(2024);
    let table: TableState = createTable({
      seats: Array.from({ length: 6 }, (_, i) => ({ seatIndex: i, playerId: `p${i}` })),
      structure: DEFAULT_BLIND_STRUCTURE,
      seatCount: 6,
    });
    let hands = 0;
    while (contestingSeats(table).length >= 2 && hands < 5_000) {
      table = { ...table, levelIndex: Math.min(Math.floor(hands / 25), 14) };
      table = startHand(table, rng).table;
      hands++;
      while (table.hand && table.hand.actingSeat !== null) {
        const seatIndex = table.hand.actingSeat;
        const legal = legalActions(table.hand, seatIndex);
        const pot = table.hand.seats.reduce((sum, s) => sum + s.totalCommitted, 0);
        table = act(table, seatIndex, chooseAction(legal, pot, rng)).table;
      }
      table = settleHand(table).table;
      for (const seat of table.seats.filter((s) => s.seated && s.stack <= 0)) {
        table = eliminate(table, seat.seatIndex);
      }
    }
    const survivors = contestingSeats(table);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.stack).toBe(60_000);
    expect(table.status).toBe('FINISHED');
  });
});

describe('hidden information', () => {
  it('never puts the deck or a live hole card into the event stream', () => {
    const rng = new SeededRandomSource(555);
    let table: TableState = createTable({
      seats: Array.from({ length: 5 }, (_, i) => ({ seatIndex: i, playerId: `p${i}` })),
      structure: DEFAULT_BLIND_STRUCTURE,
      seatCount: 6,
    });

    for (let hand = 0; hand < 120 && contestingSeats(table).length >= 2; hand++) {
      const started = startHand(table, rng);
      table = started.table;
      const events = [...started.events];

      while (table.hand && table.hand.actingSeat !== null) {
        const seatIndex = table.hand.actingSeat;
        const legal = legalActions(table.hand, seatIndex);
        const pot = table.hand.seats.reduce((sum, s) => sum + s.totalCommitted, 0);
        const step = act(table, seatIndex, chooseAction(legal, pot, rng));
        table = step.table;
        events.push(...step.events);
      }

      const finished = table.hand!;
      const shown = new Set((finished.result?.showdown ?? []).map((r) => r.seatIndex));
      const serialized = JSON.stringify(events);

      // No event may carry the deck, the burn pile, or a hole card belonging to
      // someone who was not required to show.
      expect(serialized).not.toContain('"deck"');
      expect(serialized).not.toContain('"burned"');
      for (const seat of finished.seats) {
        if (!seat.holeCards || shown.has(seat.seatIndex)) continue;
        const leaked = events.some(
          (e) => e.type === 'SHOWDOWN' && e.reveals.some((r) => r.seatIndex === seat.seatIndex),
        );
        expect(leaked).toBe(false);
      }

      table = settleHand(table).table;
      for (const seat of table.seats.filter((s) => s.seated && s.stack <= 0)) {
        table = eliminate(table, seat.seatIndex);
      }
    }
  });
});

describe('match pacing', () => {
  it('reports how long matches run so the blind structure can be tuned', () => {
    // Rough model: about two minutes per hand with four to six players.
    const MINUTES_PER_HAND = 2;
    const samples: number[] = [];
    for (let seed = 1; seed <= 30; seed++) {
      samples.push(playMatch(6, seed * 61).hands * MINUTES_PER_HAND);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    const p90 = samples[Math.floor(samples.length * 0.9)]!;

    // Random players bust far faster than real ones, so this is a floor check
    // rather than a target: it proves the structure terminates, and the printed
    // numbers are the input to real balancing.
    // eslint-disable-next-line no-console
    console.log(
      `pacing (random players, 6-handed): median ${median} min, p90 ${p90} min, max ${samples.at(-1)} min`,
    );
    expect(p90).toBeLessThan(180);
  });
});
