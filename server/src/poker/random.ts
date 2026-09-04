import { randomInt } from 'node:crypto';

/**
 * The engine never calls `Math.random`. Every source of chance goes through
 * this interface so that:
 *
 *   - production shuffles are cryptographically secure and unbiased, and
 *   - tests can replay an exact deck by injecting a seeded source.
 *
 * `nextInt` must return a uniformly distributed integer in [0, maxExclusive).
 */
export interface RandomSource {
  nextInt(maxExclusive: number): number;
}

/** Production source. `crypto.randomInt` is uniform (it rejects biased draws). */
export class CryptoRandomSource implements RandomSource {
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt requires a positive integer bound, got ${maxExclusive}`);
    }
    if (maxExclusive === 1) return 0;
    return randomInt(maxExclusive);
  }
}

/**
 * Deterministic source for tests and replays. Uses xoshiro-style mixing
 * (splitmix64 truncated to 32 bits) — good enough for reproducible test decks,
 * and deliberately *not* exported anywhere a real match can reach it.
 */
export class SeededRandomSource implements RandomSource {
  #state: number;

  constructor(seed: number) {
    // Avoid the zero fixed point.
    this.#state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  }

  #next(): number {
    // xorshift32
    let x = this.#state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#state = x | 0;
    return (x >>> 0) / 0x1_0000_0000;
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt requires a positive integer bound, got ${maxExclusive}`);
    }
    // Rejection-free is fine here: this source is for tests, not for money.
    return Math.floor(this.#next() * maxExclusive) % maxExclusive;
  }
}

/**
 * In-place Fisher-Yates. Every permutation is equally likely given an unbiased
 * source, which is the entire guarantee the "poker is sacred" rule rests on.
 */
export function shuffleInPlace<T>(items: T[], rng: RandomSource): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}
