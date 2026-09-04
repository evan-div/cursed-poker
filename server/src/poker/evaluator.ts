import {
  HandCategoryValue,
  RANK_COUNT,
  rankOf,
  suitOf,
  type Card,
  type HandCategory,
} from '@cursed/shared';

/**
 * Hand evaluation.
 *
 * A hand collapses to a single integer `score`; higher always wins and equal
 * scores are an exact tie. The packing is:
 *
 *     score = (category << 20) | (k1 << 16) | (k2 << 12) | (k3 << 8) | (k4 << 4) | k5
 *
 * where `k1..k5` are the five ranks that define the hand, best first, padded
 * with zeroes for categories that need fewer. Two hands of the same category
 * always fill the same number of kicker slots, so the padding never changes an
 * outcome.
 *
 * Two evaluators live in this file on purpose:
 *
 *   `evaluate`          - bitmask based, handles 5-7 cards directly. Used in play.
 *   `evaluateReference` - sorting based, evaluates every 5-card subset. Used by
 *                         the test suite to cross-check `evaluate` over millions
 *                         of hands.
 *
 * They are written in deliberately different styles so that a bug is unlikely
 * to be mirrored in both.
 */

export interface HandRank {
  score: number;
  category: HandCategory;
  /** The five ranks that define the hand, best first. */
  kickers: number[];
}

const CATEGORY_SHIFT = 20;

function pack(category: HandCategory, kickers: number[]): HandRank {
  let score = HandCategoryValue[category] << CATEGORY_SHIFT;
  for (let i = 0; i < 5; i++) {
    score |= (kickers[i] ?? 0) << (16 - i * 4);
  }
  return { score, category, kickers };
}

/** Highest rank of the best straight in `rankMask`, or -1. Wheel-aware. */
function straightHighRank(rankMask: number): number {
  for (let top = RANK_COUNT - 1; top >= 4; top--) {
    const window = 0b11111 << (top - 4);
    if ((rankMask & window) === window) return top;
  }
  // A-2-3-4-5: ace plays low and the straight is "to the five" (rank index 3).
  const wheel = (1 << 12) | 0b1111;
  if ((rankMask & wheel) === wheel) return 3;
  return -1;
}

/** The `count` highest set bits of `mask`, high first. */
function topRanks(mask: number, count: number): number[] {
  const out: number[] = [];
  for (let r = RANK_COUNT - 1; r >= 0 && out.length < count; r--) {
    if (mask & (1 << r)) out.push(r);
  }
  return out;
}

function withoutRanks(mask: number, ranks: number[]): number {
  let m = mask;
  for (const r of ranks) m &= ~(1 << r);
  return m;
}

/**
 * Evaluates the best five-card hand from 5, 6 or 7 cards.
 * In Hold'em this is always called with 7 (two hole cards plus a full board).
 */
export function evaluate(cards: readonly Card[]): HandRank {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate expects 5-7 cards, got ${cards.length}`);
  }

  const rankCounts = new Array<number>(RANK_COUNT).fill(0);
  const suitCounts = [0, 0, 0, 0];
  const suitRankMasks = [0, 0, 0, 0];
  let rankMask = 0;

  for (const card of cards) {
    const r = rankOf(card);
    const s = suitOf(card);
    rankCounts[r]!++;
    suitCounts[s]!++;
    suitRankMasks[s]! |= 1 << r;
    rankMask |= 1 << r;
  }

  const flushSuit = suitCounts.findIndex((n) => n >= 5);

  if (flushSuit >= 0) {
    const sfTop = straightHighRank(suitRankMasks[flushSuit]!);
    if (sfTop >= 0) return pack('STRAIGHT_FLUSH', [sfTop]);
  }

  // Rank multiplicities, high first.
  let quad = -1;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = RANK_COUNT - 1; r >= 0; r--) {
    const n = rankCounts[r]!;
    if (n === 4 && quad < 0) quad = r;
    else if (n === 3) trips.push(r);
    else if (n === 2) pairs.push(r);
  }

  if (quad >= 0) {
    const kicker = topRanks(withoutRanks(rankMask, [quad]), 1);
    return pack('FOUR_OF_A_KIND', [quad, ...kicker]);
  }

  if (trips.length > 0) {
    // A second set of trips plays as the pair half of a full house.
    const tripRank = trips[0]!;
    const pairCandidates = [...trips.slice(1), ...pairs];
    if (pairCandidates.length > 0) {
      const pairRank = Math.max(...pairCandidates);
      return pack('FULL_HOUSE', [tripRank, pairRank]);
    }
  }

  if (flushSuit >= 0) {
    return pack('FLUSH', topRanks(suitRankMasks[flushSuit]!, 5));
  }

  const straightTop = straightHighRank(rankMask);
  if (straightTop >= 0) return pack('STRAIGHT', [straightTop]);

  if (trips.length > 0) {
    const tripRank = trips[0]!;
    return pack('THREE_OF_A_KIND', [tripRank, ...topRanks(withoutRanks(rankMask, [tripRank]), 2)]);
  }

  if (pairs.length >= 2) {
    const [high, low] = [pairs[0]!, pairs[1]!];
    // A third pair cannot be used as a pair, but its rank is still a live kicker.
    const kicker = topRanks(withoutRanks(rankMask, [high, low]), 1);
    return pack('TWO_PAIR', [high, low, ...kicker]);
  }

  if (pairs.length === 1) {
    const pairRank = pairs[0]!;
    return pack('PAIR', [pairRank, ...topRanks(withoutRanks(rankMask, [pairRank]), 3)]);
  }

  return pack('HIGH_CARD', topRanks(rankMask, 5));
}

/** Negative when `a` loses, zero on an exact tie, positive when `a` wins. */
export function compareHands(a: HandRank, b: HandRank): number {
  return a.score - b.score;
}

// ---------------------------------------------------------------------------
// Reference implementation (tests only)
// ---------------------------------------------------------------------------

/** Straightforward, slow, obviously-correct evaluation of exactly five cards. */
export function evaluateFive(cards: readonly Card[]): HandRank {
  if (cards.length !== 5) throw new Error(`evaluateFive expects 5 cards, got ${cards.length}`);

  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  const distinct = [...new Set(ranks)].sort((a, b) => b - a);
  let straightTop = -1;
  if (distinct.length === 5) {
    if (distinct[0]! - distinct[4]! === 4) straightTop = distinct[0]!;
    else if (distinct[0] === 12 && distinct[1] === 3 && distinct[4] === 0) straightTop = 3; // wheel
  }

  if (isFlush && straightTop >= 0) return pack('STRAIGHT_FLUSH', [straightTop]);

  // Group ranks by multiplicity, ordering by count first then rank.
  const groups = distinct
    .map((rank) => ({ rank, count: ranks.filter((r) => r === rank).length }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  const counts = groups.map((g) => g.count).join('');
  const order = groups.map((g) => g.rank);

  if (counts === '41') return pack('FOUR_OF_A_KIND', order);
  if (counts === '32') return pack('FULL_HOUSE', order);
  if (isFlush) return pack('FLUSH', ranks);
  if (straightTop >= 0) return pack('STRAIGHT', [straightTop]);
  if (counts === '311') return pack('THREE_OF_A_KIND', order);
  if (counts === '221') return pack('TWO_PAIR', order);
  if (counts === '2111') return pack('PAIR', order);
  return pack('HIGH_CARD', ranks);
}

/** Every 5-card subset of `cards`, best score wins. Slow; for tests. */
export function evaluateReference(cards: readonly Card[]): HandRank {
  if (cards.length < 5) throw new Error(`evaluateReference expects >= 5 cards`);
  let best: HandRank | null = null;
  for (const combo of combinations(cards, 5)) {
    const rank = evaluateFive(combo);
    if (!best || rank.score > best.score) best = rank;
  }
  return best!;
}

/**
 * The actual five cards making up the best hand. Only needed at showdown for
 * presentation (highlighting the winning cards), so brute force is fine.
 */
export function bestFiveCards(cards: readonly Card[]): Card[] {
  let best: { rank: HandRank; combo: Card[] } | null = null;
  for (const combo of combinations(cards, 5)) {
    const rank = evaluateFive(combo);
    if (!best || rank.score > best.rank.score) best = { rank, combo };
  }
  return best!.combo;
}

function* combinations<T>(items: readonly T[], size: number): Generator<T[]> {
  const n = items.length;
  if (size > n) return;
  const idx = Array.from({ length: size }, (_, i) => i);
  for (;;) {
    yield idx.map((i) => items[i]!);
    let i = size - 1;
    while (i >= 0 && idx[i] === i + n - size) i--;
    if (i < 0) return;
    idx[i]!++;
    for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1]! + 1;
  }
}
