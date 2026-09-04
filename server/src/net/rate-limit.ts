/**
 * Token-bucket rate limiting.
 *
 * Two things need it: message flooding on an open socket, and lobby-code
 * guessing. Without the second, a private lobby is only private by obscurity —
 * 887 million codes fall quickly to an unthrottled attacker.
 */

export interface RateLimitOptions {
  /** Maximum burst. */
  capacity: number;
  /** Sustained rate. */
  refillPerSecond: number;
  now?: () => number;
}

export class RateLimiter {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(options: RateLimitOptions) {
    this.#capacity = options.capacity;
    this.#refillPerMs = options.refillPerSecond / 1000;
    this.#now = options.now ?? Date.now;
  }

  /** Takes `cost` tokens if available. Returns false when the caller is over budget. */
  tryConsume(key: string, cost = 1): boolean {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#capacity, updatedAt: now };

    bucket.tokens = Math.min(
      this.#capacity,
      bucket.tokens + (now - bucket.updatedAt) * this.#refillPerMs,
    );
    bucket.updatedAt = now;

    if (bucket.tokens < cost) {
      this.#buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= cost;
    this.#buckets.set(key, bucket);
    return true;
  }

  forget(key: string): void {
    this.#buckets.delete(key);
  }

  /** Drops buckets that have refilled completely, so the map cannot grow forever. */
  sweep(): void {
    const now = this.#now();
    for (const [key, bucket] of this.#buckets) {
      const refilled = bucket.tokens + (now - bucket.updatedAt) * this.#refillPerMs;
      if (refilled >= this.#capacity) this.#buckets.delete(key);
    }
  }

  get size(): number {
    return this.#buckets.size;
  }
}
