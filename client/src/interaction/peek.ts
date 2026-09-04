import { PEEK } from '@cursed/shared';

/**
 * Lifting your own cards.
 *
 * The one interaction in the game that is analog. There is no "show cards"
 * button: the player holds an input and draws the pointer toward themselves, and
 * the corner of the card comes up by however much they pulled. Stopping halfway
 * leaves it halfway — enough to read a rank, not enough to read a suit — and
 * that is a real choice, because everybody at the table can see the card move.
 *
 * The state machine is pure and frame-driven so the *feel* is testable: how far
 * a given pull lifts a card, how quickly a released card falls, and whether a
 * lift that never happened still reports zero. Anything that needs a DOM event
 * or a mesh lives in the controller that drives this.
 */

export interface PeekOptions {
  /** Pointer travel from flat to fully lifted. */
  travelPixels?: number;
  /** How fast a released card falls back, in exposure per second. */
  dropPerSecond?: number;
  /**
   * Extra travel needed per unit of unsteadiness, 0..1.
   *
   * Phase 6 feeds a stressed player's tremor in here: holding a card still
   * enough to read is harder when your hands are shaking. It does nothing yet,
   * and when it does it changes no odds — a shaking player sees the same card,
   * they just work harder to see it, in front of everybody.
   */
  unsteadiness?: number;
}

export class PeekGesture {
  #exposure = 0;
  #holding = false;
  /** Pointer travel accumulated during the current hold, in pixels. */
  #pulled = 0;
  #unsteadiness = 0;
  #options: Required<PeekOptions>;

  constructor(options: PeekOptions = {}) {
    this.#options = {
      travelPixels: options.travelPixels ?? PEEK.travelPixels,
      dropPerSecond: options.dropPerSecond ?? PEEK.dropPerSecond,
      unsteadiness: options.unsteadiness ?? 0,
    };
    this.#unsteadiness = this.#options.unsteadiness;
  }

  /** 0 flat on the felt, 1 fully lifted. */
  get exposure(): number {
    return this.#exposure;
  }

  get holding(): boolean {
    return this.#holding;
  }

  /** True once the card is up far enough to read a rank off the corner. */
  get rankVisible(): boolean {
    return this.#exposure >= PEEK.rankVisibleAt;
  }

  setUnsteadiness(value: number): void {
    this.#unsteadiness = clamp01(value);
  }

  /**
   * Takes hold of the cards.
   *
   * Resumes from the exposure already reached rather than starting over, so a
   * nervous re-check is a small movement instead of a full lift every time.
   */
  begin(): void {
    if (this.#holding) return;
    this.#holding = true;
    this.#pulled = this.#exposure * this.#travel();
  }

  /** Pointer movement while held. Positive `dy` is toward the player. */
  move(dy: number): void {
    if (!this.#holding || !Number.isFinite(dy)) return;
    this.#pulled = clamp(this.#pulled + dy, 0, this.#travel());
    this.#exposure = this.#pulled / this.#travel();
  }

  release(): void {
    this.#holding = false;
    this.#pulled = 0;
  }

  /** Lets a released card fall. Held cards stay exactly where they were put. */
  update(deltaSeconds: number): void {
    if (this.#holding || this.#exposure === 0) return;
    this.#exposure = Math.max(0, this.#exposure - this.#options.dropPerSecond * deltaSeconds);
  }

  /** Drops everything, for a new hand or a fold. */
  reset(): void {
    this.#holding = false;
    this.#pulled = 0;
    this.#exposure = 0;
  }

  #travel(): number {
    // A steady hand needs the nominal travel; an unsteady one needs half again.
    return this.#options.travelPixels * (1 + this.#unsteadiness * 0.5);
  }
}

/**
 * How far the near edge of a card has come off the felt, in radians.
 *
 * Eased rather than linear: the first part of a pull barely moves the card, so
 * a twitch is not a tell, and the last part opens it decisively. Peeking should
 * be a decision, not an accident.
 */
export function liftAngle(exposure: number): number {
  const e = clamp01(exposure);
  return PEEK.maxLift * e * e * (3 - 2 * e);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
