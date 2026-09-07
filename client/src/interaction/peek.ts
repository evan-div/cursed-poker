import { HAND_LIFT, PEEK } from '@cursed/shared';

/**
 * Lifting your own cards.
 *
 * The one interaction in the game that is analog. There is no "show cards"
 * button: the player holds an input and draws the pointer toward themselves, and
 * the corner of the card comes up by however much they pulled. Stopping halfway
 * leaves it halfway — enough to read a rank, not enough to read a suit — and
 * that is a real choice, because everybody at the table can see the card move.
 *
 * Keep pulling past a full curl and the gesture **breaks through**: the cards
 * come off the felt entirely and up in front of your face, where you can simply
 * look at them. That second stage is the loudest thing anybody can do at this
 * table, and it is deliberately on the far side of a short dead zone, so it
 * takes a decision rather than an overshoot.
 *
 * The state machine is pure and frame-driven so the *feel* is testable: how far
 * a given pull curls a card, where the break point sits, how quickly released
 * cards fall, and whether a lift that never happened still reports zero.
 * Anything that needs a DOM event or a mesh lives in the controller that drives
 * this.
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
  #lift = 0;
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

  /** 0 flat on the felt, 1 fully curled. */
  get exposure(): number {
    return this.#exposure;
  }

  /**
   * 0 still on the table, 1 held up in front of the player's face.
   *
   * Only ever above zero once the curl is complete and the player has kept
   * pulling through the break point.
   */
  get lift(): number {
    return this.#lift;
  }

  /** True once the cards have left the felt. Everybody can see this. */
  get lifted(): boolean {
    return this.#lift > 0;
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
    this.#pulled = this.#pullFor(this.#exposure, this.#lift);
  }

  /** Pointer movement while held. Positive `dy` is toward the player. */
  move(dy: number): void {
    if (!this.#holding || !Number.isFinite(dy)) return;
    this.#pulled = clamp(this.#pulled + dy, 0, this.#fullPull());
    this.#applyPull();
  }

  release(): void {
    this.#holding = false;
    this.#pulled = 0;
  }

  /**
   * Lets released cards fall. Held cards stay exactly where they were put.
   *
   * Raised cards come down first and then uncurl, in the order they went up: a
   * hand returns to the felt before it flattens onto it.
   */
  update(deltaSeconds: number): void {
    if (this.#holding) return;

    if (this.#lift > 0) {
      this.#lift = Math.max(0, this.#lift - HAND_LIFT.dropPerSecond * deltaSeconds);
      return;
    }
    if (this.#exposure === 0) return;
    this.#exposure = Math.max(0, this.#exposure - this.#options.dropPerSecond * deltaSeconds);
  }

  /** Drops everything, for a new hand or a fold. */
  reset(): void {
    this.#holding = false;
    this.#pulled = 0;
    this.#exposure = 0;
    this.#lift = 0;
  }

  #travel(): number {
    // A steady hand needs the nominal travel; an unsteady one needs half again.
    return this.#options.travelPixels * (1 + this.#unsteadiness * 0.5);
  }

  /** Where the curl ends and the dead zone before picking the cards up begins. */
  #breakPoint(): number {
    return this.#travel() + HAND_LIFT.breakPixels;
  }

  /** Total pull available: curl, then the break, then the raise. */
  #fullPull(): number {
    return this.#breakPoint() + HAND_LIFT.travelPixels;
  }

  #applyPull(): void {
    const curl = this.#travel();
    this.#exposure = clamp(this.#pulled / curl, 0, 1);
    // The dead zone between the two: the curl is complete and the cards have
    // not moved yet, so breaking through is something a player does on purpose.
    this.#lift = clamp((this.#pulled - this.#breakPoint()) / HAND_LIFT.travelPixels, 0, 1);
  }

  /** The inverse, so re-grabbing resumes from where the cards actually are. */
  #pullFor(exposure: number, lift: number): number {
    if (lift > 0) return this.#breakPoint() + lift * HAND_LIFT.travelPixels;
    return exposure * this.#travel();
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
