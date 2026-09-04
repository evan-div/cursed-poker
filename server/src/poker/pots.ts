/**
 * Pot construction and payout.
 *
 * Everything here is derived from one input per seat: how many chips that seat
 * put into the hand in total, and whether it folded. That is deliberate — it
 * means side pots cannot drift out of sync with the betting round, because
 * there is no second source of truth to drift from.
 */

export interface PotContribution {
  seatIndex: number;
  /** Total chips this seat put into the hand across every street, antes included. */
  committed: number;
  /**
   * The part of `committed` that was never a live bet — the big-blind ante.
   * Dead money still sits in the pot but it cannot come back as an uncalled
   * bet, so it is excluded when working out what nobody covered.
   */
  dead: number;
  folded: boolean;
}

export interface Pot {
  amount: number;
  /** Seats that may win this pot, ascending. Folded seats are never eligible. */
  eligibleSeats: number[];
}

export interface PotLayout {
  pots: Pot[];
  /**
   * Chips returned to a lone bettor because nobody could cover them. This is
   * *not* winnings; it never reaches a pot and never appears at showdown.
   */
  uncalledReturn: { seatIndex: number; amount: number } | null;
}

/**
 * Splits contributions into a main pot plus side pots.
 *
 * Folded seats still contribute their chips (dead money) but can never be
 * eligible to win them.
 */
export function buildPots(contributions: readonly PotContribution[]): PotLayout {
  const working = contributions.map((c) => ({ ...c }));
  const uncalledReturn = extractUncalledBet(working);

  const levels = [...new Set(working.map((c) => c.committed))]
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  const pots: Pot[] = [];
  let previousLevel = 0;

  for (const level of levels) {
    let amount = 0;
    const eligibleSeats: number[] = [];
    for (const c of working) {
      amount += Math.min(c.committed, level) - Math.min(c.committed, previousLevel);
      if (!c.folded && c.committed >= level) eligibleSeats.push(c.seatIndex);
    }
    previousLevel = level;
    if (amount <= 0) continue;

    eligibleSeats.sort((a, b) => a - b);

    if (eligibleSeats.length === 0) {
      // Everyone who reached this level folded. Their chips belong to whoever
      // wins the layer below rather than vanishing.
      const previous = pots[pots.length - 1];
      if (previous) previous.amount += amount;
      else pots.push({ amount, eligibleSeats: [] });
      continue;
    }

    const previous = pots[pots.length - 1];
    if (previous && sameSeats(previous.eligibleSeats, eligibleSeats)) {
      previous.amount += amount;
    } else {
      pots.push({ amount, eligibleSeats });
    }
  }

  return { pots, uncalledReturn };
}

/**
 * Returns the part of the leading bet that nobody covered.
 *
 * Only a seat that is still in the hand can get chips back: folding forfeits
 * everything already committed, no matter how much it was. The comparison uses
 * *live* commitments — the big-blind ante is dead money and can never come
 * back, so a big blind who wins an unopened pot keeps the overhang of their
 * blind but not the ante they posted for the table.
 *
 * Mutates `working` so pot layering sees the reduced commitment.
 */
function extractUncalledBet(
  working: PotContribution[],
): { seatIndex: number; amount: number } | null {
  const live = (c: PotContribution) => c.committed - c.dead;

  let top: PotContribution | null = null;
  for (const c of working) {
    if (c.folded) continue;
    if (!top || live(c) > live(top)) top = c;
  }
  if (!top) return null;

  let secondHighest = 0;
  for (const c of working) {
    if (c === top) continue;
    if (live(c) > secondHighest) secondHighest = live(c);
  }

  const excess = live(top) - secondHighest;
  if (excess <= 0) return null;

  top.committed -= excess;
  return { seatIndex: top.seatIndex, amount: excess };
}

function sameSeats(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export interface PotAward {
  potIndex: number;
  seatIndex: number;
  amount: number;
  /** True when the seat received an extra chip from an indivisible pot. */
  oddChip: boolean;
}

/**
 * Splits each pot among its winners.
 *
 * `rankBySeat` maps a seat to a comparable hand score; the highest score wins.
 * Odd chips go to the first winner clockwise from the button, which is the
 * standard live-poker rule and keeps payouts deterministic.
 */
export function awardPots(
  pots: readonly Pot[],
  rankBySeat: ReadonlyMap<number, number>,
  buttonSeat: number,
  seatCount: number,
): PotAward[] {
  const awards: PotAward[] = [];

  pots.forEach((pot, potIndex) => {
    const contenders = pot.eligibleSeats.filter((s) => rankBySeat.has(s));
    if (contenders.length === 0) return;

    let bestScore = -Infinity;
    for (const seat of contenders) {
      const score = rankBySeat.get(seat)!;
      if (score > bestScore) bestScore = score;
    }
    const winners = contenders.filter((s) => rankBySeat.get(s) === bestScore);

    const base = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - base * winners.length;

    for (const seat of orderFromButton(winners, buttonSeat, seatCount)) {
      const oddChip = remainder > 0;
      if (oddChip) remainder--;
      awards.push({ potIndex, seatIndex: seat, amount: base + (oddChip ? 1 : 0), oddChip });
    }
  });

  return awards;
}

/** Seats ordered clockwise starting from the seat left of the button. */
function orderFromButton(seats: readonly number[], buttonSeat: number, seatCount: number): number[] {
  return [...seats].sort((a, b) => {
    const da = (a - buttonSeat - 1 + seatCount * 2) % seatCount;
    const db = (b - buttonSeat - 1 + seatCount * 2) % seatCount;
    return da - db;
  });
}
