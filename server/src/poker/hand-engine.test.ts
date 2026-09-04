import { describe, expect, it } from 'vitest';
import { applyAction, createHand, legalActions } from './hand-engine.js';
import { IllegalActionError } from './hand-state.js';
import { HandDriver, seats } from './test-utils.js';
import { SeededRandomSource } from './random.js';

const BLINDS = { smallBlind: 50, bigBlind: 100, ante: 0 };

const sixHanded = (stack = 10_000, buttonSeat = 0) =>
  new HandDriver({
    handNumber: 1,
    seats: seats([0, stack], [1, stack], [2, stack], [3, stack], [4, stack], [5, stack]),
    buttonSeat,
    seatCount: 6,
    config: BLINDS,
    rng: new SeededRandomSource(1),
  });

describe('blinds and button', () => {
  it('posts the blinds to the left of the button with three or more players', () => {
    const d = sixHanded(10_000, 2);
    expect(d.state.smallBlindSeat).toBe(3);
    expect(d.state.bigBlindSeat).toBe(4);
    expect(d.stack(3)).toBe(9_950);
    expect(d.stack(4)).toBe(9_900);
    expect(d.state.currentBet).toBe(100);
  });

  it('skips empty seats when finding the blinds', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [3, 10_000], [4, 10_000]),
      buttonSeat: 4,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(2),
    });
    expect(d.state.smallBlindSeat).toBe(0);
    expect(d.state.bigBlindSeat).toBe(3);
  });

  it('makes the button the small blind heads-up', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([2, 10_000], [5, 10_000]),
      buttonSeat: 2,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(3),
    });
    expect(d.state.smallBlindSeat).toBe(2);
    expect(d.state.bigBlindSeat).toBe(5);
    // Heads-up the button acts first before the flop.
    expect(d.acting).toBe(2);
  });

  it('posts a partial blind when the stack cannot cover it', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 30], [2, 10_000]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(4),
    });
    expect(d.stack(1)).toBe(0);
    expect(d.state.seats.find((s) => s.seatIndex === 1)!.allIn).toBe(true);
    // The nominal big blind is still what everyone else has to match.
    expect(d.state.currentBet).toBe(100);
  });
});

describe('turn order', () => {
  it('opens under the gun before the flop and left of the button after it', () => {
    const d = sixHanded(10_000, 0); // SB 1, BB 2
    expect(d.acting).toBe(3);
    d.act({ type: 'CALL' }); // 3
    d.act({ type: 'FOLD' }); // 4
    d.act({ type: 'FOLD' }); // 5
    d.act({ type: 'FOLD' }); // 0 (button)
    d.act({ type: 'FOLD' }); // 1 (SB)
    expect(d.acting).toBe(2); // big blind gets the option
    d.act({ type: 'CHECK' });
    expect(d.state.phase).toBe('FLOP');
    expect(d.acting).toBe(2); // first live seat left of the button
  });

  it('gives the big blind the option after a limped pot', () => {
    const d = sixHanded(10_000, 0);
    d.act({ type: 'CALL' }).act({ type: 'CALL' }).act({ type: 'CALL' });
    d.act({ type: 'CALL' }).act({ type: 'CALL' }); // button and small blind
    expect(d.acting).toBe(2);
    expect(d.legal().canCheck).toBe(true);
    expect(d.legal().canRaise).toBe(true);
  });

  it('reverses order heads-up after the flop', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 10_000]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(5),
    });
    expect(d.acting).toBe(0); // button/SB first preflop
    d.act({ type: 'CALL' });
    d.act({ type: 'CHECK' }); // BB option
    expect(d.state.phase).toBe('FLOP');
    expect(d.acting).toBe(1); // big blind acts first postflop
  });
});

describe('bet sizing rules', () => {
  it('requires at least a full raise', () => {
    const d = sixHanded();
    const legal = d.legal();
    expect(legal.callAmount).toBe(100);
    expect(legal.minRaiseTo).toBe(200);
    expect(legal.maxRaiseTo).toBe(10_000);
    expect(() => d.act({ type: 'RAISE', to: 150 })).toThrow(IllegalActionError);
  });

  it('grows the minimum raise with the size of the last raise', () => {
    const d = sixHanded();
    d.act({ type: 'RAISE', to: 300 }); // raise of 200 over the 100 blind
    expect(d.legal().minRaiseTo).toBe(500);
    d.act({ type: 'RAISE', to: 900 }); // raise of 600
    expect(d.legal().minRaiseTo).toBe(1_500);
  });

  it('sets the minimum post-flop bet to one big blind', () => {
    const d = sixHanded(10_000, 0);
    d.act({ type: 'FOLD' }).act({ type: 'FOLD' }).act({ type: 'FOLD' });
    d.act({ type: 'FOLD' }).act({ type: 'CALL' }); // small blind completes
    d.act({ type: 'CHECK' }); // big blind
    expect(d.state.phase).toBe('FLOP');
    expect(d.legal().minRaiseTo).toBe(100);
    expect(() => d.act({ type: 'BET', to: 50 })).toThrow(IllegalActionError);
  });

  it('rejects betting when facing a bet, and raising when there is none', () => {
    const d = sixHanded();
    expect(() => d.act({ type: 'BET', to: 500 })).toThrow(/raise instead/);
    d.act({ type: 'FOLD' }).act({ type: 'FOLD' }).act({ type: 'FOLD' });
    d.act({ type: 'FOLD' }).act({ type: 'CALL' }).act({ type: 'CHECK' });
    expect(() => d.act({ type: 'RAISE', to: 500 })).toThrow(/bet instead/);
  });

  it('rejects a check when chips are owed and a call when none are', () => {
    const d = sixHanded();
    expect(() => d.act({ type: 'CHECK' })).toThrow(/Cannot check/);
    d.act({ type: 'FOLD' }).act({ type: 'FOLD' }).act({ type: 'FOLD' });
    d.act({ type: 'FOLD' }).act({ type: 'CALL' }).act({ type: 'CHECK' });
    expect(() => d.act({ type: 'CALL' })).toThrow(/nothing to call/);
  });

  it('allows a short stack to shove below the minimum raise', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 10_000], [2, 400]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(6),
    });
    // Seat 2 is the big blind with 300 behind; the button opens to 300, which
    // makes a full raise 500 — more than seat 2 owns.
    d.act({ type: 'RAISE', to: 300 }); // seat 0
    d.act({ type: 'FOLD' }); // seat 1 (small blind)
    const legal = d.legal();
    expect(legal.seatIndex).toBe(2);
    expect(legal.canRaise).toBe(true);
    expect(legal.raiseIsAllInOnly).toBe(true);
    expect(legal.minRaiseTo).toBe(400);
    expect(legal.maxRaiseTo).toBe(400);
    d.act({ type: 'ALL_IN' });
    expect(d.stack(2)).toBe(0);
  });
});

describe('reopening the betting', () => {
  it('does not reopen for players who already acted when an all-in is short', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 10_000], [2, 900], [3, 10_000]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(7),
    });
    // Seats: button 0, SB 1, BB 2 (900 chips), UTG 3.
    d.act({ type: 'RAISE', to: 600 }, 3); // opens to 600; a full raise is 500
    d.act({ type: 'CALL' }, 0);
    d.act({ type: 'FOLD' }, 1);
    d.act({ type: 'ALL_IN' }, 2); // 900 total: a raise of only 300 over 600

    // Seats 3 and 0 already acted at 600 and now face an undersized all-in.
    expect(d.acting).toBe(3);
    expect(d.legal(3).canRaise).toBe(false);
    expect(d.legal(3).callAmount).toBe(300);
    expect(() => d.act({ type: 'RAISE', to: 3_000 }, 3)).toThrow(/not available/);
    d.act({ type: 'CALL' }, 3);
    expect(d.legal(0).canRaise).toBe(false);
  });

  it('reopens the betting when the all-in is a full raise', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 10_000], [2, 1_400], [3, 10_000]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(8),
    });
    d.act({ type: 'RAISE', to: 600 }, 3);
    d.act({ type: 'CALL' }, 0);
    d.act({ type: 'FOLD' }, 1);
    d.act({ type: 'ALL_IN' }, 2); // 1,400: a raise of 800 over 600 — a full raise
    expect(d.acting).toBe(3);
    expect(d.legal(3).canRaise).toBe(true);
    expect(d.legal(3).minRaiseTo).toBe(2_200);
  });

  it('turns a shove into a call when raise rights are closed', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 10_000], [2, 10_000], [3, 750]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(9),
    });
    d.act({ type: 'RAISE', to: 600 }, 3);
    d.act({ type: 'RAISE', to: 1_200 }, 0);
    d.act({ type: 'FOLD' }, 1);
    d.act({ type: 'CALL' }, 2);
    d.act({ type: 'ALL_IN' }, 3);
    // Seat 0 owes nothing and cannot raise, so it must check or fold.
    expect(d.legal(0).canCheck).toBe(true);
    expect(() => d.act({ type: 'ALL_IN' }, 0)).toThrow(IllegalActionError);
  });

  it('leaves raise rights intact for a player who had not yet acted', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 10_000], [2, 10_000], [3, 750]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(10),
    });
    d.act({ type: 'RAISE', to: 600 }, 3);
    d.act({ type: 'ALL_IN' }, 0); // full raise, well over the minimum
    d.act({ type: 'FOLD' }, 1);
    // Seat 2 has not acted; facing a huge raise it keeps full rights (though
    // with everyone else all-in or folded, raising is moot).
    expect(d.acting).toBe(2);
    expect(d.legal(2).canCall).toBe(true);
  });

  it('never lets a player raise when no opponent can answer', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 400]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(11),
    });
    d.act({ type: 'CALL' }, 0);
    d.act({ type: 'ALL_IN' }, 1); // seat 1 shoves 400
    expect(d.legal(0).canRaise).toBe(false);
    expect(d.legal(0).callAmount).toBe(300);
  });
});

describe('ending a hand', () => {
  it('ends the moment everyone folds and shows nobody', () => {
    const d = sixHanded(10_000, 0);
    d.act({ type: 'FOLD' }).act({ type: 'FOLD' }).act({ type: 'FOLD' });
    d.act({ type: 'FOLD' }).act({ type: 'FOLD' });
    expect(d.state.phase).toBe('COMPLETE');
    expect(d.state.result!.showdown).toBeNull();
    expect(d.state.result!.contenders).toEqual([2]);
    // Big blind collects the small blind and gets its own blind back.
    expect(d.stack(2)).toBe(10_050);
    expect(d.stack(1)).toBe(9_950);
  });

  it('returns the part of a bet nobody called', () => {
    const d = sixHanded(10_000, 0);
    d.act({ type: 'RAISE', to: 3_000 }, 3);
    d.act({ type: 'FOLD' }, 4).act({ type: 'FOLD' }, 5).act({ type: 'FOLD' }, 0);
    d.act({ type: 'FOLD' }, 1).act({ type: 'FOLD' }, 2);
    expect(d.state.result!.uncalledReturn).toEqual({ seatIndex: 3, amount: 2_900 });
    expect(d.stack(3)).toBe(10_150);
  });

  it('runs the board out when everyone is all-in', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 5_000], [1, 5_000]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      hole: { 0: 'AcAd', 1: 'KcKd' },
      board: 'Ah 7c 2d 9s 3h',
    });
    d.act({ type: 'ALL_IN' }, 0);
    d.act({ type: 'CALL' }, 1);
    expect(d.state.phase).toBe('COMPLETE');
    expect(d.state.board).toHaveLength(5);
    expect(d.stack(0)).toBe(10_000);
    expect(d.stack(1)).toBe(0);
    expect(d.eventsOfType('STREET_DEALT').map((e) => e.street)).toEqual(['FLOP', 'TURN', 'RIVER']);
  });

  it('splits a pot between identical hands', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 5_000], [1, 5_000]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      hole: { 0: 'AcKc', 1: 'AdKd' },
      board: '2h 7s 9c Jd 4s',
    });
    d.act({ type: 'ALL_IN' }, 0);
    d.act({ type: 'CALL' }, 1);
    expect(d.stack(0)).toBe(5_000);
    expect(d.stack(1)).toBe(5_000);
  });

  it('builds side pots so a short all-in can only win what it covered', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 6_000], [1, 6_000], [2, 1_000]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      // Seat 2 is the big blind with the best hand but only 1,000 chips.
      hole: { 0: 'KcKd', 1: 'QcQd', 2: 'AcAd' },
      board: '2h 7s 9c Jd 4s',
    });
    d.act({ type: 'ALL_IN' }, 0);
    d.act({ type: 'CALL' }, 1);
    d.act({ type: 'ALL_IN' }, 2); // only 1,000 behind: a call, not a raise

    expect(d.state.phase).toBe('COMPLETE');
    expect(d.state.result!.pots).toEqual([
      { amount: 3_000, eligibleSeats: [0, 1, 2] },
      { amount: 10_000, eligibleSeats: [0, 1] },
    ]);
    // Main pot to the aces, side pot to the kings; the queens get nothing.
    expect(d.stack(2)).toBe(3_000);
    expect(d.stack(0)).toBe(10_000);
    expect(d.stack(1)).toBe(0);
    expect(d.stack(0) + d.stack(1) + d.stack(2)).toBe(13_000);
  });

  it('reports the winning five cards at showdown', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 5_000], [1, 5_000]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      hole: { 0: 'AcAd', 1: '7h8h' },
      board: '5h 6h 9h Ts 2c',
    });
    d.act({ type: 'ALL_IN' }, 0);
    d.act({ type: 'CALL' }, 1);
    const showdown = d.state.result!.showdown!;
    expect(showdown[0]!.seatIndex).toBe(1);
    expect(showdown[0]!.category).toBe('STRAIGHT_FLUSH');
    expect(showdown[0]!.bestFive).toHaveLength(5);
    expect(showdown[1]!.category).toBe('PAIR');
  });
});

describe('antes', () => {
  it('posts a big-blind ante on top of the blind', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 10_000], [2, 10_000]),
      buttonSeat: 0,
      seatCount: 6,
      config: { smallBlind: 200, bigBlind: 400, ante: 400 },
      rng: new SeededRandomSource(12),
    });
    expect(d.stack(2)).toBe(10_000 - 400 - 400);
    expect(d.state.currentBet).toBe(400);
  });

  it('keeps the ante in the pot when the pot is not contested', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 10_000], [2, 10_000]),
      buttonSeat: 0,
      seatCount: 6,
      config: { smallBlind: 200, bigBlind: 400, ante: 400 },
      rng: new SeededRandomSource(13),
    });
    d.act({ type: 'FOLD' }, 0).act({ type: 'FOLD' }, 1);
    // Big blind is up exactly the small blind: the ante it posted is its own.
    expect(d.stack(2)).toBe(10_200);
    expect(d.stack(1)).toBe(9_800);
    expect(d.stack(0)).toBe(10_000);
  });

  it('takes the ante before the blind from a stack that cannot cover both', () => {
    const d = new HandDriver({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 10_000], [2, 300]),
      buttonSeat: 0,
      seatCount: 6,
      config: { smallBlind: 200, bigBlind: 400, ante: 400 },
      rng: new SeededRandomSource(14),
    });
    const bb = d.state.seats.find((s) => s.seatIndex === 2)!;
    expect(bb.deadCommitted).toBe(300);
    expect(bb.betThisRound).toBe(0);
    expect(bb.allIn).toBe(true);
  });
});

describe('engine contracts', () => {
  it('never mutates the state it was handed', () => {
    const first = createHand({
      handNumber: 1,
      seats: seats([0, 10_000], [1, 10_000], [2, 10_000]),
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(15),
    });
    const before = structuredClone(first.state);
    applyAction(first.state, first.state.actingSeat!, { type: 'RAISE', to: 500 });
    expect(first.state).toEqual(before);
  });

  it('refuses an action from a seat that is not on turn', () => {
    const d = sixHanded();
    expect(() => d.act({ type: 'FOLD' }, 5)).toThrow(/turn/);
  });

  it('refuses any action once the hand is complete', () => {
    const d = sixHanded(10_000, 0);
    d.act({ type: 'FOLD' }).act({ type: 'FOLD' }).act({ type: 'FOLD' });
    d.act({ type: 'FOLD' }).act({ type: 'FOLD' });
    expect(() => applyAction(d.state, 2, { type: 'CHECK' })).toThrow(/over/);
  });

  it('rejects fractional and oversized bets', () => {
    const d = sixHanded();
    expect(() => d.act({ type: 'RAISE', to: 250.5 })).toThrow(/whole number/);
    expect(() => d.act({ type: 'RAISE', to: 99_999 })).toThrow(/stack allows/);
  });

  it('rejects malformed table setups', () => {
    const base = {
      handNumber: 1,
      buttonSeat: 0,
      seatCount: 6,
      config: BLINDS,
      rng: new SeededRandomSource(16),
    };
    expect(() => createHand({ ...base, seats: seats([0, 100]) })).toThrow(/at least 2/);
    expect(() => createHand({ ...base, seats: seats([0, 100], [1, 0]) })).toThrow(/positive/);
    expect(() => createHand({ ...base, seats: seats([1, 100], [2, 100]) })).toThrow(/not occupied/);
    expect(() => createHand({ ...base, seats: seats([0, 100], [9, 100]) })).toThrow(/outside/);
    expect(() =>
      createHand({ ...base, seats: seats([0, 100], [1, 100]), config: { ...BLINDS, smallBlind: 200 } }),
    ).toThrow(/Small blind/);
  });

  it('exposes legal actions that match what the engine accepts', () => {
    const d = sixHanded();
    const legal = legalActions(d.state, d.acting!);
    expect(legal.canFold).toBe(true);
    expect(legal.canCheck).toBe(false);
    expect(legal.canCall).toBe(true);
    expect(legal.canRaise).toBe(true);
    expect(legal.raiseIsAllInOnly).toBe(false);
  });

  it('keeps the deck out of every event it emits', () => {
    const d = sixHanded(10_000, 0);
    d.act({ type: 'FOLD' }).act({ type: 'FOLD' }).act({ type: 'FOLD' });
    d.act({ type: 'FOLD' }).act({ type: 'CALL' }).act({ type: 'CHECK' });
    const serialized = JSON.stringify(d.events);
    expect(serialized).not.toContain('deck');
    expect(serialized).not.toContain('burned');
    // Hole cards only ever appear inside a showdown reveal.
    const holeEvents = d.eventsOfType('HOLE_CARDS_DEALT');
    expect(holeEvents).toHaveLength(1);
    expect(Object.keys(holeEvents[0]!)).toEqual(['type', 'seats']);
  });
});
