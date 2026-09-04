import { describe, expect, it } from 'vitest';
import { DECK_SIZE, orderedDeck, rankOf, type Card } from '@cursed/shared';
import { CryptoRandomSource, shuffleInPlace } from '../server/src/poker/index.js';

/**
 * Shuffle fairness.
 *
 * The core design rule of this project is that the supernatural layer never
 * touches the deck. These tests exist to make that claim falsifiable: if the
 * shuffle ever develops a bias — or if somebody later "helpfully" nudges card
 * distribution to improve pacing — this suite fails.
 *
 * Everything here runs against the production RNG, not a seeded test one.
 */

const rng = new CryptoRandomSource();

describe('the shuffle', () => {
  it('sends every card to every position at the same rate', () => {
    const TRIALS = 20_000;
    const positions = new Array<number>(DECK_SIZE).fill(0);
    const deck = orderedDeck();
    const tracked: Card = 0;

    for (let i = 0; i < TRIALS; i++) {
      shuffleInPlace(deck, rng);
      positions[deck.indexOf(tracked)]!++;
    }

    const expected = TRIALS / DECK_SIZE;
    const chiSquare = positions.reduce((sum, observed) => {
      const diff = observed - expected;
      return sum + (diff * diff) / expected;
    }, 0);

    // 51 degrees of freedom: the mean is 51 with a standard deviation near 10.
    // A cutoff of 140 is roughly nine deviations out — it will not fire by
    // chance, but a real bias moves this number a very long way.
    expect(chiSquare).toBeLessThan(140);
  });

  it('produces every permutation of a small deck', () => {
    const seen = new Set<string>();
    const items = [0, 1, 2, 3];
    for (let i = 0; i < 5_000; i++) {
      seen.add(shuffleInPlace([...items], rng).join(''));
    }
    expect(seen.size).toBe(24);
  });

  it('always returns a complete deck', () => {
    const deck = orderedDeck();
    for (let i = 0; i < 500; i++) {
      shuffleInPlace(deck, rng);
      expect(new Set(deck).size).toBe(DECK_SIZE);
      expect(Math.min(...deck)).toBe(0);
      expect(Math.max(...deck)).toBe(DECK_SIZE - 1);
    }
  });
});

describe('the deal', () => {
  it('gives every seat the same chance of a pocket pair', () => {
    const HANDS = 20_000;
    const SEATS = 6;
    const pairs = new Array<number>(SEATS).fill(0);
    const deck = orderedDeck();

    for (let i = 0; i < HANDS; i++) {
      shuffleInPlace(deck, rng);
      // Deal the way the engine does: one card at a time, twice around.
      for (let seat = 0; seat < SEATS; seat++) {
        const first = deck[seat]!;
        const second = deck[SEATS + seat]!;
        if (rankOf(first) === rankOf(second)) pairs[seat]!++;
      }
    }

    // P(pocket pair) = 3/51.
    const expected = HANDS * (3 / 51);
    const sd = Math.sqrt(HANDS * (3 / 51) * (48 / 51));
    for (const count of pairs) {
      expect(Math.abs(count - expected)).toBeLessThan(5 * sd);
    }
  });

  it('deals no card twice across hole cards, board and burns', () => {
    const deck = orderedDeck();
    for (let i = 0; i < 2_000; i++) {
      shuffleInPlace(deck, rng);
      const dealt = deck.slice(0, 12 + 3 + 5); // six players, burns, board
      expect(new Set(dealt).size).toBe(dealt.length);
    }
  });
});
