/**
 * Card representation.
 *
 * A card is a single integer 0..51 encoded as `rank * 4 + suit`.
 *
 *   rank: 0..12  ->  2 3 4 5 6 7 8 9 T J Q K A   (ace high; the wheel is handled
 *                                                 by the evaluator, not the encoding)
 *   suit: 0..3   ->  c d h s
 *
 * Integers keep the hand evaluator branch-light and make deck/board arrays cheap
 * to clone, which matters because the engine snapshots state on every action.
 */

export const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUIT_CHARS = ['c', 'd', 'h', 's'] as const;

export const RANK_COUNT = 13;
export const SUIT_COUNT = 4;
export const DECK_SIZE = RANK_COUNT * SUIT_COUNT;

/** 0..12, where 0 is a deuce and 12 is an ace. */
export type Rank = number;
/** 0..3 -> clubs, diamonds, hearts, spades. */
export type Suit = number;
/** 0..51. */
export type Card = number;

export function makeCard(rank: Rank, suit: Suit): Card {
  return rank * SUIT_COUNT + suit;
}

export function rankOf(card: Card): Rank {
  return (card / SUIT_COUNT) | 0;
}

export function suitOf(card: Card): Suit {
  return card % SUIT_COUNT;
}

export function cardToString(card: Card): string {
  return `${RANK_CHARS[rankOf(card)]}${SUIT_CHARS[suitOf(card)]}`;
}

export function cardsToString(cards: readonly Card[]): string {
  return cards.map(cardToString).join(' ');
}

/** Parses a single card such as "As", "td", "7C". Throws on anything else. */
export function cardFromString(text: string): Card {
  if (text.length !== 2) throw new Error(`Invalid card "${text}"`);
  const rank = RANK_CHARS.indexOf(text[0]!.toUpperCase() as (typeof RANK_CHARS)[number]);
  const suit = SUIT_CHARS.indexOf(text[1]!.toLowerCase() as (typeof SUIT_CHARS)[number]);
  if (rank < 0 || suit < 0) throw new Error(`Invalid card "${text}"`);
  return makeCard(rank, suit);
}

/** Parses "AsKd" or "As Kd" or "As,Kd" into cards. Used heavily by tests. */
export function cardsFromString(text: string): Card[] {
  const cleaned = text.replace(/[\s,]/g, '');
  if (cleaned.length % 2 !== 0) throw new Error(`Invalid card list "${text}"`);
  const out: Card[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    out.push(cardFromString(cleaned.slice(i, i + 2)));
  }
  return out;
}

/** A fresh, ordered 52-card deck. Callers must shuffle before use. */
export function orderedDeck(): Card[] {
  const deck: Card[] = new Array(DECK_SIZE);
  for (let i = 0; i < DECK_SIZE; i++) deck[i] = i;
  return deck;
}
