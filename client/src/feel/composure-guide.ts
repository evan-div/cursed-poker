import { COMPOSURE_KINDS, type ComposureChallengeView, type ComposureInput } from '@cursed/shared';

/**
 * What to show a player while they steady themselves.
 *
 * Pure and clocked by the caller, like `Pulse`, so the feel is testable. It
 * judges nothing: the server does that, from when its own inputs arrived. This
 * only draws the guide — and it draws it the way the server will judge it, so
 * a player following the guide is doing the thing that scores.
 *
 * The breath guide anchors each beat on the player's own previous tap, not on
 * a fixed schedule, because what the server scores is the gap between two taps.
 * A player who came in late on one beat is shown the right gap from where they
 * actually are, rather than chasing a rhythm they have already lost.
 */

export type GuideState =
  | { kind: 'BREATH'; stage: 'WAITING' }
  | {
      kind: 'BREATH';
      stage: 'BREATHING';
      /** Taps made so far, and how many there will be. */
      taps: number;
      of: number;
      /** 0 just after a tap, 1 when the next one is due; past 1 is late. */
      phase: number;
    }
  | { kind: 'BREATH'; stage: 'DONE' }
  | { kind: 'HOLD'; stage: 'WAITING' }
  | {
      kind: 'HOLD';
      stage: 'HOLDING';
      /** 0 when the key went down, 1 when it should come up. Keeps going past. */
      fill: number;
      /** How much of the guide is still showing, 0..1. It fades before the end. */
      visible: number;
    }
  | { kind: 'HOLD'; stage: 'RELEASED' }
  | { kind: string; stage: 'UNKNOWN' };

/** When the hold guide starts to fade, and when it is gone. */
export const HOLD_GUIDE = { fadeFrom: 0.45, goneAt: 0.72 } as const;

export class ComposureGuide {
  readonly challenge: ComposureChallengeView;
  #taps: number[] = [];
  #downAt: number | null = null;
  #released = false;

  constructor(challenge: ComposureChallengeView) {
    this.challenge = challenge;
  }

  get id(): string {
    return this.challenge.id;
  }

  /** The player pressed or let go, at the caller's clock. */
  press(input: ComposureInput, now: number): void {
    if (this.challenge.kind === COMPOSURE_KINDS.BREATH) {
      if (input === 'DOWN') this.#taps.push(now);
      return;
    }
    if (this.challenge.kind === COMPOSURE_KINDS.HOLD) {
      if (input === 'DOWN' && this.#downAt === null) this.#downAt = now;
      else if (input === 'UP' && this.#downAt !== null) this.#released = true;
    }
  }

  state(now: number): GuideState {
    if (this.challenge.kind === COMPOSURE_KINDS.BREATH) return this.#breath(now);
    if (this.challenge.kind === COMPOSURE_KINDS.HOLD) return this.#hold(now);
    return { kind: this.challenge.kind, stage: 'UNKNOWN' };
  }

  #breath(now: number): GuideState {
    const gaps = (this.challenge.spec.gapsMs as number[] | undefined) ?? [];
    const of = gaps.length + 1;
    const taps = this.#taps.length;
    if (taps === 0) return { kind: 'BREATH', stage: 'WAITING' };
    if (taps >= of) return { kind: 'BREATH', stage: 'DONE' };
    const last = this.#taps[taps - 1]!;
    const gap = gaps[taps - 1]!;
    return { kind: 'BREATH', stage: 'BREATHING', taps, of, phase: Math.max(0, (now - last) / gap) };
  }

  #hold(now: number): GuideState {
    if (this.#released) return { kind: 'HOLD', stage: 'RELEASED' };
    if (this.#downAt === null) return { kind: 'HOLD', stage: 'WAITING' };
    const holdMs = (this.challenge.spec.holdMs as number | undefined) ?? 1;
    const fill = Math.max(0, (now - this.#downAt) / holdMs);
    const fade = (fill - HOLD_GUIDE.fadeFrom) / (HOLD_GUIDE.goneAt - HOLD_GUIDE.fadeFrom);
    return { kind: 'HOLD', stage: 'HOLDING', fill, visible: 1 - Math.min(Math.max(fade, 0), 1) };
  }
}
