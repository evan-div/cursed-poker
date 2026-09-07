import { RANK_CHARS, rankOf, suitOf, type Card } from '@cursed/shared';

/**
 * A card, small enough to read in a sentence.
 *
 * The log used to spell cards out — "flop: 9h 6d Kh" — which is a thing you
 * decode rather than a thing you see. At the edge of the screen, during a hand,
 * nobody decodes anything: three little cards register at a glance and three
 * pairs of letters do not.
 *
 * Deliberately tiny and flat. This is a *reference* to a card, not a picture of
 * one; the actual cards are on the table, and anything more detailed here would
 * compete with them.
 */

const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'];
const SUIT_NAMES = ['clubs', 'diamonds', 'hearts', 'spades'];

export function cardChip(card: Card): HTMLElement {
  const suit = suitOf(card);
  const chip = document.createElement('span');
  chip.className = `chip-card ${SUIT_NAMES[suit]}`;

  const rank = document.createElement('b');
  rank.textContent = RANK_CHARS[rankOf(card)] ?? '?';
  const pip = document.createElement('i');
  pip.textContent = SUIT_GLYPHS[suit] ?? '?';

  chip.append(rank, pip);
  // Screen readers and anyone hovering still get the plain name.
  chip.title = `${rank.textContent}${SUIT_GLYPHS[suit]}`;
  return chip;
}
