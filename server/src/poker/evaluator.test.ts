import { describe, expect, it } from 'vitest';
import { cardFromString, cardsFromString, orderedDeck, rankOf, type Card } from '@cursed/shared';
import { bestFiveCards, evaluate, evaluateFive, evaluateReference } from './evaluator.js';
import { SeededRandomSource, shuffleInPlace } from './random.js';

const hand = (text: string) => evaluate(cardsFromString(text));
const cat = (text: string) => hand(text).category;

describe('category detection', () => {
  it('reads every category from a seven-card hand', () => {
    expect(cat('AsKsQsJsTs 2h 3d')).toBe('STRAIGHT_FLUSH');
    expect(cat('7c7d7h7s Kc 2d 3h')).toBe('FOUR_OF_A_KIND');
    expect(cat('9c9d9h 4s4d Kc 2h')).toBe('FULL_HOUSE');
    expect(cat('Ah9h7h4h2h Ks Qd')).toBe('FLUSH');
    expect(cat('5c6d7h8s9c Kd 2h')).toBe('STRAIGHT');
    expect(cat('QcQdQh 7s 4d 2h 9c')).toBe('THREE_OF_A_KIND');
    expect(cat('JcJd 5h5s Kc 8d 2h')).toBe('TWO_PAIR');
    expect(cat('AcAd Kh 9s 5d 3h 2c')).toBe('PAIR');
    expect(cat('AcKd9h7s5d 3h 2c')).toBe('HIGH_CARD');
  });

  it('reads the wheel as a five-high straight', () => {
    const wheel = hand('Ac2d3h4s5c Kd Qh');
    expect(wheel.category).toBe('STRAIGHT');
    // Rank index 3 is the five.
    expect(wheel.kickers[0]).toBe(3);
    expect(wheel.score).toBeLessThan(hand('2c3d4h5s6c Kd Qh').score);
  });

  it('reads the steel wheel as a five-high straight flush', () => {
    const steel = hand('Ac2c3c4c5c Kd Qh');
    expect(steel.category).toBe('STRAIGHT_FLUSH');
    expect(steel.score).toBeLessThan(hand('2c3c4c5c6c Kd Qh').score);
  });

  it('does not read a wrap-around as a straight', () => {
    expect(cat('QcKdAh2s3c 7h 9d')).toBe('HIGH_CARD');
  });

  it('picks the highest straight when several are present', () => {
    const h = hand('5c6d7h8s9cTdJh');
    expect(h.category).toBe('STRAIGHT');
    expect(h.kickers[0]).toBe(rankOf(cardFromString('Jh')));
  });

  it('prefers a flush over a straight on the same board', () => {
    expect(cat('5h6h7h8h9c Td 2h')).toBe('FLUSH');
  });

  it('prefers a full house over a flush', () => {
    // Seven cards can never hold both at once — a boat and a flush share at
    // most two cards, so it would take eight — hence the shared-board matchup.
    const board = cardsFromString('Kh5h5s7h8h');
    const boat = evaluate([...cardsFromString('KsKd'), ...board]);
    const flush = evaluate([...cardsFromString('2h9h'), ...board]);
    expect(boat.category).toBe('FULL_HOUSE');
    expect(flush.category).toBe('FLUSH');
    expect(boat.score).toBeGreaterThan(flush.score);
  });

  it('uses the higher trips and the best remaining pair for a full house', () => {
    const h = hand('9c9d9h 5s5d5c Kh');
    expect(h.category).toBe('FULL_HOUSE');
    expect(h.kickers.slice(0, 2)).toEqual([7, 3]); // nines full of fives
  });

  it('treats a third pair as a kicker, never as a third pair', () => {
    const h = hand('AcAd KhKs 2c2d 9h');
    expect(h.category).toBe('TWO_PAIR');
    expect(h.kickers.slice(0, 3)).toEqual([12, 11, 7]); // aces and kings, nine kicker
  });

  it('finds a straight flush hidden alongside a bigger flush suit', () => {
    // Six hearts on the table; only five of them run.
    const h = hand('2h3h4h5h6h Ah Kd');
    expect(h.category).toBe('STRAIGHT_FLUSH');
    expect(h.kickers[0]).toBe(4); // six high
  });
});

describe('ordering', () => {
  it('ranks the classic ladder correctly', () => {
    const ladder = [
      'AcKd9h7s5d 3h 2c', // high card
      'AcAd Kh 9s 5d 3h 2c', // pair
      'JcJd 5h5s Kc 8d 2h', // two pair
      'QcQdQh 7s 4d 2h 9c', // trips
      '5c6d7h8s9c Kd 2h', // straight
      'Ah9h7h4h2h Ks Qd', // flush
      '9c9d9h 4s4d Kc 2h', // full house
      '7c7d7h7s Kc 2d 3h', // quads
      'AsKsQsJsTs 2h 3d', // straight flush
    ].map((t) => hand(t).score);

    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]).toBeGreaterThan(ladder[i - 1]!);
    }
  });

  it('separates flushes by every kicker', () => {
    expect(hand('AhKh9h7h5h 2c 3d').score).toBeGreaterThan(hand('AhKh9h7h4h 2c 3d').score);
    expect(hand('AhKh9h7h5h 2c 3d').score).toBeGreaterThan(hand('AhQh9h7h5h 2c 3d').score);
  });

  it('separates one pair by all three kickers', () => {
    expect(hand('AcAd KsQh9d 2c 3h').score).toBeGreaterThan(hand('AcAd KsQh8d 2c 3h').score);
  });

  it('scores identical hands from different suits as an exact tie', () => {
    expect(hand('AcKd 5h 9s Th 2c 3d').score).toBe(hand('AhKs 5c 9d Tc 2h 3s').score);
  });

  it('plays the board when neither player improves it', () => {
    const board = cardsFromString('AsKsQsJhTh');
    const a = evaluate([...cardsFromString('2c3d'), ...board]);
    const b = evaluate([...cardsFromString('4h5s'), ...board]);
    expect(a.score).toBe(b.score);
    expect(a.category).toBe('STRAIGHT');
  });
});

describe('cross-validation against the reference evaluator', () => {
  it('agrees on 200,000 random seven-card hands', () => {
    const rng = new SeededRandomSource(0xc0ffee);
    const deck = orderedDeck();
    let checked = 0;

    for (let i = 0; i < 200_000; i++) {
      shuffleInPlace(deck, rng);
      const seven = deck.slice(0, 7) as Card[];
      const fast = evaluate(seven);
      const slow = evaluateReference(seven);
      if (fast.score !== slow.score || fast.category !== slow.category) {
        throw new Error(
          `Mismatch on ${seven.join(',')}: fast=${fast.category}/${fast.score} slow=${slow.category}/${slow.score}`,
        );
      }
      checked++;
    }

    expect(checked).toBe(200_000);
  });

  it('agrees on every five-card hand it is given', () => {
    const rng = new SeededRandomSource(1234);
    const deck = orderedDeck();
    for (let i = 0; i < 20_000; i++) {
      shuffleInPlace(deck, rng);
      const five = deck.slice(0, 5) as Card[];
      expect(evaluate(five).score).toBe(evaluateFive(five).score);
    }
  });

  it('preserves the ordering of random matchups', () => {
    const rng = new SeededRandomSource(777);
    const deck = orderedDeck();
    for (let i = 0; i < 50_000; i++) {
      shuffleInPlace(deck, rng);
      const board = deck.slice(0, 5) as Card[];
      const a = deck.slice(5, 7) as Card[];
      const b = deck.slice(7, 9) as Card[];
      const fast = Math.sign(evaluate([...a, ...board]).score - evaluate([...b, ...board]).score);
      const slow = Math.sign(
        evaluateReference([...a, ...board]).score - evaluateReference([...b, ...board]).score,
      );
      expect(fast).toBe(slow);
    }
  });
});

describe('bestFiveCards', () => {
  it('returns five cards that score the same as the full hand', () => {
    const rng = new SeededRandomSource(42);
    const deck = orderedDeck();
    for (let i = 0; i < 5_000; i++) {
      shuffleInPlace(deck, rng);
      const seven = deck.slice(0, 7) as Card[];
      const five = bestFiveCards(seven);
      expect(five).toHaveLength(5);
      expect(new Set(five).size).toBe(5);
      expect(five.every((c) => seven.includes(c))).toBe(true);
      expect(evaluateFive(five).score).toBe(evaluate(seven).score);
    }
  });
});

describe('input validation', () => {
  it('rejects hands that are too short or too long', () => {
    expect(() => evaluate(cardsFromString('AcKd2h3s'))).toThrow();
    expect(() => evaluate(cardsFromString('AcKd2h3s4d5c6h7s'))).toThrow();
  });
});
