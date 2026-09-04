import { RANK_CHARS, rankOf, suitOf, type Card } from '@cursed/shared';

const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'];
const SUIT_NAMES = ['clubs', 'diamonds', 'hearts', 'spades'];

/** Renders a card face. Phase 3 replaces this with something you can pick up. */
export function cardElement(card: Card, extraClass = ''): HTMLElement {
  const suit = suitOf(card);
  const element = document.createElement('span');
  element.className = `card ${SUIT_NAMES[suit]} ${extraClass}`.trim();
  element.innerHTML = `<b>${RANK_CHARS[rankOf(card)]}</b><i>${SUIT_GLYPHS[suit]}</i>`;
  return element;
}

export function placeholderCard(faceDown = true): HTMLElement {
  const element = document.createElement('span');
  element.className = faceDown ? 'card back' : 'card empty';
  return element;
}

export function chips(amount: number): string {
  return amount.toLocaleString('en-US');
}
