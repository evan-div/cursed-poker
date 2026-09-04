import { orderedDeck, type Card } from '@cursed/shared';
import { shuffleInPlace, type RandomSource } from './random.js';

/**
 * The deck a hand draws from.
 *
 * SERVER ONLY, AND SECRET. The remaining card order is the most valuable
 * secret in the game — it must never be serialised toward any client, not to a
 * spectator, not to an eliminated player, not after the hand ends. It lives
 * inside `HandState` because the engine is a pure function of its state, and
 * the projection layer is what keeps it from leaving the process. This type is
 * named loudly so that leak audits have something to grep for.
 */
export interface SecretDeck {
  cards: Card[];
  /** Index of the next card to come off the top. */
  index: number;
}

export function shuffledDeck(rng: RandomSource): SecretDeck {
  return { cards: shuffleInPlace(orderedDeck(), rng), index: 0 };
}

/** Builds a deck with a known order. Tests and replays only. */
export function stackedDeck(cards: readonly Card[]): SecretDeck {
  if (new Set(cards).size !== cards.length) throw new Error('Stacked deck contains duplicates');
  return { cards: [...cards], index: 0 };
}

export function cardsRemaining(deck: SecretDeck): number {
  return deck.cards.length - deck.index;
}

export function draw(deck: SecretDeck): Card {
  if (cardsRemaining(deck) <= 0) throw new Error('Deck exhausted');
  return deck.cards[deck.index++]!;
}

export function drawMany(deck: SecretDeck, count: number): Card[] {
  const out: Card[] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = draw(deck);
  return out;
}

/**
 * Burns a card. Burning cannot change any probability, but a real dealer does
 * it and the Dealer's dealing choreography is built around the beat, so the
 * engine performs it for real rather than faking it in presentation.
 */
export function burn(deck: SecretDeck): Card {
  return draw(deck);
}
