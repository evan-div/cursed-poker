import { describe, expect, it } from 'vitest';
import { awardPots, buildPots, type PotContribution } from './pots.js';

const c = (seatIndex: number, committed: number, folded = false, dead = 0): PotContribution => ({
  seatIndex,
  committed,
  dead,
  folded,
});

const totalOf = (pots: { amount: number }[]) => pots.reduce((s, p) => s + p.amount, 0);

describe('buildPots', () => {
  it('makes a single pot when everyone matched', () => {
    const { pots, uncalledReturn } = buildPots([c(0, 100), c(1, 100), c(2, 100)]);
    expect(uncalledReturn).toBeNull();
    expect(pots).toEqual([{ amount: 300, eligibleSeats: [0, 1, 2] }]);
  });

  it('keeps folded money in the pot but not its owner in the eligible set', () => {
    const { pots } = buildPots([c(0, 100), c(1, 100, true), c(2, 100)]);
    expect(pots).toEqual([{ amount: 300, eligibleSeats: [0, 2] }]);
  });

  it('layers a side pot over a short all-in', () => {
    // Seat 0 is all-in for 50; seats 1 and 2 keep betting to 200.
    const { pots } = buildPots([c(0, 50), c(1, 200), c(2, 200)]);
    expect(pots).toEqual([
      { amount: 150, eligibleSeats: [0, 1, 2] },
      { amount: 300, eligibleSeats: [1, 2] },
    ]);
    expect(totalOf(pots)).toBe(450);
  });

  it('layers three deep', () => {
    const { pots } = buildPots([c(0, 20), c(1, 60), c(2, 100), c(3, 100)]);
    expect(pots).toEqual([
      { amount: 80, eligibleSeats: [0, 1, 2, 3] },
      { amount: 120, eligibleSeats: [1, 2, 3] },
      { amount: 80, eligibleSeats: [2, 3] },
    ]);
    expect(totalOf(pots)).toBe(280);
  });

  it('returns the part of a bet nobody could cover', () => {
    const { pots, uncalledReturn } = buildPots([c(0, 500), c(1, 200)]);
    expect(uncalledReturn).toEqual({ seatIndex: 0, amount: 300 });
    expect(pots).toEqual([{ amount: 400, eligibleSeats: [0, 1] }]);
  });

  it('never returns chips to a seat that folded', () => {
    // Seat 1 folds facing the bet; their 200 stays in the pot for seat 0.
    const { pots, uncalledReturn } = buildPots([c(0, 700), c(1, 200, true)]);
    expect(uncalledReturn).toEqual({ seatIndex: 0, amount: 500 });
    expect(pots).toEqual([{ amount: 400, eligibleSeats: [0] }]);
  });

  it('forfeits a folded seat that had committed the most', () => {
    // A big blind all-in for the ante alone; the small blind folds and loses
    // the blind it posted even though that blind is the largest live bet.
    const { pots, uncalledReturn } = buildPots([c(0, 200, true), c(1, 300, false, 300)]);
    expect(uncalledReturn).toBeNull();
    expect(pots).toEqual([{ amount: 500, eligibleSeats: [1] }]);
  });

  it('does not hand the big-blind ante back as an uncalled bet', () => {
    // Blinds 200/400 with a 400 ante. Everyone folds to the big blind.
    // The big blind is owed only the 200 overhang of the blind itself.
    const { pots, uncalledReturn } = buildPots([c(1, 200, true), c(2, 800, false, 400)]);
    expect(uncalledReturn).toEqual({ seatIndex: 2, amount: 200 });
    expect(totalOf(pots)).toBe(800);
    expect(pots).toEqual([{ amount: 800, eligibleSeats: [2] }]);
  });

  it('conserves every chip across pots plus the uncalled return', () => {
    const contributions = [c(0, 37), c(1, 512, true), c(2, 512), c(3, 900), c(4, 0)];
    const { pots, uncalledReturn } = buildPots(contributions);
    const committed = contributions.reduce((s, x) => s + x.committed, 0);
    expect(totalOf(pots) + (uncalledReturn?.amount ?? 0)).toBe(committed);
  });

  it('ignores seats that put nothing in', () => {
    const { pots } = buildPots([c(0, 0), c(1, 100), c(2, 100)]);
    expect(pots).toEqual([{ amount: 200, eligibleSeats: [1, 2] }]);
  });
});

describe('awardPots', () => {
  const ranks = (entries: [number, number][]) => new Map(entries);

  it('gives the pot to the best hand', () => {
    const { pots } = buildPots([c(0, 100), c(1, 100)]);
    const awards = awardPots(pots, ranks([[0, 500], [1, 900]]), 0, 6);
    expect(awards).toEqual([{ potIndex: 0, seatIndex: 1, amount: 200, oddChip: false }]);
  });

  it('splits a tied pot evenly', () => {
    const { pots } = buildPots([c(0, 100), c(1, 100)]);
    const awards = awardPots(pots, ranks([[0, 900], [1, 900]]), 0, 6);
    expect(awards.map((a) => a.amount)).toEqual([100, 100]);
  });

  it('gives an odd chip to the first winner clockwise from the button', () => {
    // Seat 5 folded having committed one chip more than the two who saw it
    // through, so the pot is 151 and cannot split evenly.
    const { pots } = buildPots([c(1, 50), c(3, 50), c(5, 51, true)]);
    expect(pots).toEqual([{ amount: 151, eligibleSeats: [1, 3] }]);

    // Button on seat 5, so seat 1 is reached first.
    const bySeat = new Map(
      awardPots(pots, ranks([[1, 900], [3, 900]]), 5, 6).map((a) => [a.seatIndex, a.amount]),
    );
    expect(bySeat.get(1)).toBe(76);
    expect(bySeat.get(3)).toBe(75);

    // Move the button and the odd chip moves with it.
    const bySeat2 = new Map(
      awardPots(pots, ranks([[1, 900], [3, 900]]), 1, 6).map((a) => [a.seatIndex, a.amount]),
    );
    expect(bySeat2.get(3)).toBe(76);
    expect(bySeat2.get(1)).toBe(75);
  });

  it('lets a short all-in win the main pot while a deeper stack takes the side pot', () => {
    const { pots } = buildPots([c(0, 50), c(1, 200), c(2, 200)]);
    const awards = awardPots(pots, ranks([[0, 999], [1, 800], [2, 100]]), 5, 6);
    expect(awards).toEqual([
      { potIndex: 0, seatIndex: 0, amount: 150, oddChip: false },
      { potIndex: 1, seatIndex: 1, amount: 300, oddChip: false },
    ]);
  });

  it('awards every chip in every pot', () => {
    const contributions = [c(0, 33), c(1, 777), c(2, 777), c(3, 1200)];
    const { pots, uncalledReturn } = buildPots(contributions);
    const awards = awardPots(pots, ranks([[0, 5], [1, 9], [2, 9], [3, 1]]), 0, 6);
    const paid = awards.reduce((s, a) => s + a.amount, 0);
    const committed = contributions.reduce((s, x) => s + x.committed, 0);
    expect(paid + (uncalledReturn?.amount ?? 0)).toBe(committed);
  });
});
