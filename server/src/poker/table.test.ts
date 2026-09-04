import { describe, expect, it } from 'vitest';
import { DEFAULT_BLIND_STRUCTURE, TURBO_BLIND_STRUCTURE } from '@cursed/shared';
import {
  act,
  bustedSeats,
  contestingSeats,
  createTable,
  currentLevel,
  eliminate,
  grantChips,
  nextButtonSeat,
  settleHand,
  setLevelFromElapsed,
  startHand,
  type TableState,
} from './table.js';
import { SeededRandomSource } from './random.js';
import { createOrbitState, pendingSeats, recordHand } from './orbit.js';

const players = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ seatIndex: i, playerId: `p${i}` }));

const table6 = () =>
  createTable({ seats: players(6), structure: DEFAULT_BLIND_STRUCTURE, seatCount: 6 });

/** Plays a hand out by folding to the big blind. */
function foldAround(table: TableState, rng: SeededRandomSource): TableState {
  let t = startHand(table, rng).table;
  while (t.hand && t.hand.actingSeat !== null) {
    t = act(t, t.hand.actingSeat, { type: 'FOLD' }).table;
  }
  return settleHand(t).table;
}

describe('table setup', () => {
  it('gives everyone 100 big blinds', () => {
    const t = table6();
    expect(t.seats.every((s) => s.stack === 10_000)).toBe(true);
    expect(currentLevel(t).bigBlind).toBe(100);
    expect(currentLevel(t).smallBlind).toBe(50);
  });

  it('supports four, five and six players', () => {
    for (const count of [4, 5, 6]) {
      const t = createTable({
        seats: players(count),
        structure: DEFAULT_BLIND_STRUCTURE,
        seatCount: 6,
      });
      const step = startHand(t, new SeededRandomSource(count));
      expect(step.table.hand!.seats).toHaveLength(count);
      expect(contestingSeats(step.table)).toHaveLength(count);
    }
  });
});

describe('button rotation', () => {
  it('moves the button one seat per hand', () => {
    const rng = new SeededRandomSource(100);
    let t = table6();
    const buttons: number[] = [];
    for (let i = 0; i < 6; i++) {
      const started = startHand(t, rng).table;
      buttons.push(started.buttonSeat);
      let x = started;
      while (x.hand && x.hand.actingSeat !== null) {
        x = act(x, x.hand.actingSeat, { type: 'FOLD' }).table;
      }
      t = settleHand(x).table;
    }
    expect(buttons).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('never makes anyone post the big blind twice in a row', () => {
    const rng = new SeededRandomSource(101);
    let t = table6();
    let previousBigBlind: number | null = null;
    for (let i = 0; i < 40; i++) {
      const started = startHand(t, rng).table;
      const bb = started.hand!.bigBlindSeat;
      expect(bb).not.toBe(previousBigBlind);
      previousBigBlind = bb;
      let x = started;
      while (x.hand && x.hand.actingSeat !== null) {
        x = act(x, x.hand.actingSeat, { type: 'FOLD' }).table;
      }
      t = settleHand(x).table;
    }
  });

  it('skips seats that have left', () => {
    let t = table6();
    t = { ...t, seats: t.seats.map((s) => (s.seatIndex === 1 ? { ...s, stack: 0 } : s)) };
    t = eliminate(t, 1);
    expect(nextButtonSeat(t)).toBe(2);
  });
});

describe('blind progression', () => {
  it('advances with elapsed match time', () => {
    let t = table6();
    expect(currentLevel(t).level).toBe(1);
    t = setLevelFromElapsed(t, 8 * 60 - 1);
    expect(currentLevel(t).level).toBe(1);
    t = setLevelFromElapsed(t, 8 * 60);
    expect(currentLevel(t).level).toBe(2);
    t = setLevelFromElapsed(t, 5 * 8 * 60);
    expect(currentLevel(t).level).toBe(6);
    expect(currentLevel(t).ante).toBe(600);
  });

  it('clamps to the final level rather than running out', () => {
    const t = setLevelFromElapsed(table6(), 100 * 60 * 60);
    expect(currentLevel(t).level).toBe(DEFAULT_BLIND_STRUCTURE.levels.length);
  });

  it('refuses to change the level mid-hand', () => {
    const t = startHand(table6(), new SeededRandomSource(102)).table;
    expect(() => setLevelFromElapsed(t, 60 * 60)).toThrow(/while a hand is in progress/);
  });

  it('uses the level that was live when the hand started', () => {
    let t = setLevelFromElapsed(table6(), 8 * 60);
    t = startHand(t, new SeededRandomSource(103)).table;
    expect(t.hand!.config.bigBlind).toBe(150);
  });
});

describe('settlement', () => {
  it('writes stacks back and reports who busted without removing them', () => {
    const rng = new SeededRandomSource(104);
    let t = createTable({
      seats: [
        { seatIndex: 0, playerId: 'p0', stack: 10_000 },
        { seatIndex: 1, playerId: 'p1', stack: 200 },
      ],
      structure: DEFAULT_BLIND_STRUCTURE,
      seatCount: 6,
    });
    t = startHand(t, rng).table;
    while (t.hand && t.hand.actingSeat !== null) {
      t = act(t, t.hand.actingSeat, { type: 'ALL_IN' }).table;
    }
    const { table: settled, settlement } = settleHand(t);
    expect(settled.seats.reduce((s, x) => s + x.stack, 0)).toBe(10_200);
    if (settlement.busted.length > 0) {
      // Busted players stay seated: the sacrifice window has not run yet.
      expect(settled.seats.find((s) => s.seatIndex === settlement.busted[0])!.seated).toBe(true);
    }
  });

  it('conserves chips over a long run of hands', () => {
    const rng = new SeededRandomSource(105);
    let t = table6();
    const total = () => t.seats.reduce((s, x) => s + x.stack, 0);
    const opening = total();
    for (let i = 0; i < 60 && contestingSeats(t).length >= 2; i++) {
      t = foldAround(t, rng);
      expect(total()).toBe(opening);
    }
  });

  it('settles a hand that ended before anyone could act', () => {
    // Both stacks are swallowed by the blinds, so the board just runs out.
    let t = createTable({
      seats: [
        { seatIndex: 0, playerId: 'p0', stack: 40 },
        { seatIndex: 1, playerId: 'p1', stack: 40 },
      ],
      structure: DEFAULT_BLIND_STRUCTURE,
      seatCount: 6,
    });
    const started = startHand(t, new SeededRandomSource(109));
    expect(started.table.hand!.phase).toBe('COMPLETE');
    expect(started.table.status).toBe('AWAITING_SETTLEMENT');

    t = settleHand(started.table).table;
    expect(t.seats.reduce((s, x) => s + x.stack, 0)).toBe(80);
  });

  it('refuses to settle when no hand has finished', () => {
    expect(() => settleHand(table6())).toThrow(/no finished hand/i);
  });
});

describe('the between-hands seam', () => {
  it('adds sacrifice chips only between hands', () => {
    let t = table6();
    t = grantChips(t, 3, 25_000, 'sacrifice:PALM_SLICE');
    expect(t.seats.find((s) => s.seatIndex === 3)!.stack).toBe(35_000);

    const mid = startHand(t, new SeededRandomSource(106)).table;
    expect(() => grantChips(mid, 3, 1_000, 'sacrifice')).toThrow(/while a hand is in progress/);
  });

  it('rejects nonsense grants', () => {
    const t = table6();
    expect(() => grantChips(t, 3, 0, 'x')).toThrow(/positive integer/);
    expect(() => grantChips(t, 3, -5, 'x')).toThrow(/positive integer/);
    expect(() => grantChips(t, 9, 100, 'x')).toThrow(/No seat/);
  });

  it('only eliminates a player who actually has nothing', () => {
    let t = table6();
    expect(() => eliminate(t, 2)).toThrow(/still has/);
    t = { ...t, seats: t.seats.map((s) => (s.seatIndex === 2 ? { ...s, stack: 0 } : s)) };
    expect(bustedSeats(t).map((s) => s.seatIndex)).toEqual([2]);
    t = eliminate(t, 2);
    expect(t.seats.find((s) => s.seatIndex === 2)!.seated).toBe(false);
    expect(contestingSeats(t)).toHaveLength(5);
  });

  it('finishes the match when one player is left', () => {
    let t = table6();
    for (const seat of [1, 2, 3, 4, 5]) {
      t = { ...t, seats: t.seats.map((s) => (s.seatIndex === seat ? { ...s, stack: 0 } : s)) };
      t = eliminate(t, seat);
    }
    expect(t.status).toBe('FINISHED');
    expect(() => startHand(t, new SeededRandomSource(107))).toThrow(/match is over/);
  });
});

describe('first orbit', () => {
  it('completes once every player has held the button', () => {
    const rng = new SeededRandomSource(108);
    let t = createTable({ seats: players(5), structure: TURBO_BLIND_STRUCTURE, seatCount: 6 });
    let orbit = createOrbitState(t.seats.map((s) => s.seatIndex));

    const completedAfter: number[] = [];
    for (let i = 0; i < 5; i++) {
      const started = startHand(t, rng).table;
      const buttonSeat = started.buttonSeat;
      let x = started;
      while (x.hand && x.hand.actingSeat !== null) {
        x = act(x, x.hand.actingSeat, { type: 'FOLD' }).table;
      }
      t = settleHand(x).table;
      orbit = recordHand(orbit, {
        buttonSeat,
        remainingSeats: contestingSeats(t).map((s) => s.seatIndex),
      });
      if (orbit.complete) completedAfter.push(i + 1);
    }

    expect(orbit.visited).toEqual([0, 1, 2, 3, 4]);
    expect(completedAfter[0]).toBe(5);
  });

  it('does not wait for a player who has left', () => {
    let orbit = createOrbitState([0, 1, 2, 3]);
    orbit = recordHand(orbit, { buttonSeat: 0, remainingSeats: [0, 1, 2, 3] });
    expect(orbit.complete).toBe(false);
    expect(pendingSeats(orbit, [0, 1, 2, 3])).toEqual([1, 2, 3]);

    orbit = recordHand(orbit, { buttonSeat: 1, remainingSeats: [0, 1, 2] });
    orbit = recordHand(orbit, { buttonSeat: 2, remainingSeats: [0, 1, 2] });
    expect(orbit.complete).toBe(true);
    expect(pendingSeats(orbit, [0, 1, 2])).toEqual([]);
  });

  it('never stalls past one hand per starting seat', () => {
    let orbit = createOrbitState([0, 1, 2, 3]);
    // Pathological: the same seat keeps the button somehow.
    for (let i = 0; i < 4; i++) {
      orbit = recordHand(orbit, { buttonSeat: 0, remainingSeats: [0, 1, 2, 3] });
    }
    expect(orbit.complete).toBe(true);
  });

  it('stops changing once complete', () => {
    let orbit = createOrbitState([0, 1]);
    orbit = recordHand(orbit, { buttonSeat: 0, remainingSeats: [0, 1] });
    orbit = recordHand(orbit, { buttonSeat: 1, remainingSeats: [0, 1] });
    expect(orbit.complete).toBe(true);
    const after = recordHand(orbit, { buttonSeat: 0, remainingSeats: [0, 1] });
    expect(after).toBe(orbit);
  });
});
