import type { ComposureInput, ComposureView } from '@cursed/shared';
import { ComposureGuide } from '../feel/composure-guide.js';
import { el } from './dom.js';

/**
 * Steadying yourself, on screen.
 *
 * A small thing low in the middle of the view: a ring to breathe in time with,
 * or a breath to hold. Drawn from `ComposureGuide`, which knows the rhythm; this
 * only puts it on the screen — and shakes it, by as much as your own hands are
 * shaking, because keeping time is harder when you are frightened. That shake
 * is local: it comes from your own felt tremor and goes nowhere.
 *
 * Nothing here decides anything. Key presses go straight to the server, which
 * times them on arrival and says how it went; this shows what it said.
 */

/** How long a result's word stays on screen. */
const RESULT_MS = 2_400;

export class ComposureOverlay {
  readonly root: HTMLElement;
  #target = el('div', 'composure-target');
  #ring = el('div', 'composure-ring');
  #label = el('div', 'composure-label');
  #word = el('div', 'composure-word');
  #guide: ComposureGuide | null = null;
  #lastResultUntil = 0;
  #wordUntil = 0;
  #seed = 0;

  constructor() {
    this.root = el('div', 'composure');
    this.root.setAttribute('aria-live', 'polite');
    const dial = el('div', 'composure-dial');
    dial.append(this.#target, this.#ring);
    this.root.append(dial, this.#label, this.#word);
  }

  /** The id of the challenge in progress, if there is one. */
  get challengeId(): string | null {
    return this.#guide?.id ?? null;
  }

  /** The server's word on your composure, from the latest view. */
  apply(view: ComposureView, now: number): void {
    const challenge = view.challenge;
    if (!challenge) this.#guide = null;
    else if (challenge.id !== this.#guide?.id) this.#guide = new ComposureGuide(challenge);

    // A result is shown once, when it first arrives.
    if (view.result && view.result.until !== this.#lastResultUntil) {
      this.#lastResultUntil = view.result.until;
      this.#word.textContent = view.result.outcome === 'STEADIED' ? 'steadied' : 'you faltered';
      this.#word.dataset.outcome = view.result.outcome;
      this.#wordUntil = now + RESULT_MS;
    }
  }

  /** A key went down or came up. Returns whether a challenge was listening. */
  press(input: ComposureInput, now: number): boolean {
    if (!this.#guide) return false;
    this.#guide.press(input, now);
    return true;
  }

  /** Once a frame. `tremor` is your own felt shake, 0..1. */
  frame(now: number, tremor: number): void {
    const showingWord = now < this.#wordUntil;
    this.#word.style.opacity = showingWord ? String(Math.min(1, (this.#wordUntil - now) / 600)) : '0';
    this.root.classList.toggle('active', this.#guide !== null || showingWord);
    if (!this.#guide) {
      this.#ring.style.opacity = '0';
      this.#target.style.opacity = '0';
      this.#label.textContent = '';
      return;
    }

    // Shaken by your own hands. A few pixels, never enough to make it unreadable.
    this.#seed += 1;
    const shake = tremor * tremor * 7;
    const dx = shake * Math.sin(now * 0.061 + this.#seed * 1.7);
    const dy = shake * Math.sin(now * 0.053 + this.#seed * 2.3);
    this.root.style.transform = `translate(calc(-50% + ${dx.toFixed(1)}px), ${dy.toFixed(1)}px)`;

    const state = this.#guide.state(now);
    this.root.dataset.kind = state.kind;
    switch (state.stage) {
      case 'WAITING':
        this.#target.style.opacity = '0.8';
        this.#ring.style.opacity = '0';
        this.#label.textContent = state.kind === 'HOLD' ? 'hold space — let go when it would have filled' : 'tap space, then breathe with the ring';
        break;
      case 'BREATHING': {
        // The ring closes on the target as the next breath comes due, and
        // brightens as it lands.
        const closing = Math.min(state.phase, 1);
        this.#ring.style.transform = `scale(${(1 + 1.6 * (1 - closing)).toFixed(3)})`;
        this.#ring.style.opacity = (0.25 + 0.75 * closing).toFixed(2);
        this.#ring.style.background = '';
        this.#target.style.opacity = '0.8';
        this.#label.textContent = `breathe  ${'•'.repeat(state.taps)}${'·'.repeat(state.of - state.taps)}`;
        break;
      }
      case 'HOLDING':
        this.#ring.style.transform = 'scale(1)';
        this.#ring.style.opacity = state.visible.toFixed(2);
        this.#ring.style.background = `conic-gradient(rgba(208, 186, 140, 0.55) ${(Math.min(state.fill, 1) * 360).toFixed(0)}deg, transparent 0deg)`;
        this.#target.style.opacity = (0.3 + 0.5 * state.visible).toFixed(2);
        this.#label.textContent = state.visible > 0 ? 'hold…' : 'count it out';
        break;
      case 'DONE':
      case 'RELEASED':
        this.#ring.style.opacity = '0';
        this.#target.style.opacity = '0.4';
        this.#label.textContent = '';
        break;
      default:
        this.#label.textContent = 'steady yourself';
    }
  }
}
