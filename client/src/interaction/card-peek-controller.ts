import { PeekGesture } from './peek.js';

/**
 * The input half of peeking.
 *
 * Deliberately not tied to pointing at anything. Aiming a crosshair at a playing
 * card in a dark room is fiddly and would make the most-used interaction in the
 * game the most annoying one, and it is also unnecessary: these are *your*
 * cards, in front of you, and you know where they are. Hold the right mouse
 * button or `V`, and draw toward yourself.
 *
 * What still governs whether you can *read* them is where you are looking. The
 * card lifts toward its owner's eyes, so a player peeking while staring across
 * the table sees nothing much — which is worth knowing, because looking down at
 * your hand is itself replicated, and doing it is a thing people notice.
 */

export interface CardPeekOptions {
  /** Called the first time a hold begins in a hand: ask the server for the cards. */
  onFirstLook: () => void;
  /** Called whenever exposure changes, for reporting and rendering. */
  onExposure: (exposure: number) => void;
}

const PEEK_KEY = 'v';

export class CardPeekController {
  readonly gesture = new PeekGesture();

  #options: CardPeekOptions;
  #detach: (() => void) | null = null;
  #looked = false;
  #lastReported = -1;

  constructor(options: CardPeekOptions) {
    this.#options = options;
  }

  get holding(): boolean {
    return this.gesture.holding;
  }

  get exposure(): number {
    return this.gesture.exposure;
  }

  /** A new hand: the cards go back down and the look must be earned again. */
  reset(): void {
    this.gesture.reset();
    this.#looked = false;
    this.#emit();
  }

  attach(element: HTMLElement): void {
    const begin = () => {
      if (this.gesture.holding) return;
      this.gesture.begin();
      // Asked for on the *first* hold of a hand rather than when the card is
      // high enough to read, so the cards are already here by the time the
      // player has pulled far enough to want them.
      if (!this.#looked) {
        this.#looked = true;
        this.#options.onFirstLook();
      }
    };

    const down = (event: PointerEvent) => {
      if (event.button !== 2) return;
      event.preventDefault();
      begin();
    };
    const up = (event: PointerEvent) => {
      if (event.button !== 2) return;
      this.gesture.release();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== PEEK_KEY || event.repeat) return;
      if (isTyping(event.target)) return;
      begin();
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== PEEK_KEY) return;
      this.gesture.release();
    };
    // Losing focus mid-hold would otherwise leave a card up forever, which the
    // whole table can see.
    const blur = () => this.gesture.release();
    const menu = (event: Event) => event.preventDefault();

    element.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    element.addEventListener('contextmenu', menu);

    this.#detach = () => {
      element.removeEventListener('pointerdown', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
      element.removeEventListener('contextmenu', menu);
    };
  }

  detach(): void {
    this.#detach?.();
    this.#detach = null;
  }

  /** Pointer movement, handed over by the camera while the gesture is held. */
  pointerMoved(_dx: number, dy: number): void {
    this.gesture.move(dy);
    this.#emit();
  }

  /** Lets a released card fall. */
  update(deltaSeconds: number): void {
    this.gesture.update(deltaSeconds);
    this.#emit();
  }

  #emit(): void {
    if (this.gesture.exposure === this.#lastReported) return;
    this.#lastReported = this.gesture.exposure;
    this.#options.onExposure(this.gesture.exposure);
  }
}

function isTyping(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  return node.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName);
}
