/**
 * Composure: hiding what your body is doing.
 *
 * ---
 *
 * ## What it is
 *
 * Phase 6 made fear visible. Every seat's tremor, breathing and sweat is on
 * every screen, and by the design of the stress model it follows what is
 * happening *to* a player and what they themselves do — never what they hold.
 * A tell that follows your own behaviour can be managed. This is the managing.
 *
 * A player who wants to steady themselves asks for it. The server issues a
 * short challenge — a breathing rhythm to tap out, a breath to hold for just
 * long enough — and judges what comes back. Do it well and your tells go quiet
 * for a while. Do it badly and they get worse, because a person who tries to
 * look calm and fails looks worse than one who never tried.
 *
 * ## What it is not
 *
 * **It does not touch your heart.** A composed player is exactly as frightened
 * as before; their own heart rate, which only they receive, does not move. What
 * changes is what everybody else is shown. That is the honest version of the
 * skill — you cannot stop being afraid, only stop showing it — and it is also
 * the architecture: composure sits between the stress model and the broadcast,
 * and the stress model does not know it exists.
 *
 * **It is never a client's word.** The client sends raw key presses. The server
 * timestamps them when they arrive and does all of the judging; there is no
 * message a client can send that means "I succeeded". Timing is judged on the
 * *intervals* between presses rather than on when they arrived, so a slow
 * connection costs nothing and a fast one gains nothing — both presses of an
 * interval crossed the same wire.
 *
 * **It is private.** Only you are told a challenge is running. The table sees
 * the result, in your tells, the same way it sees everything else about you.
 */

/** The kinds of challenge, by name. Open, so a new one is a new module. */
export type ComposureKind = string;

/** The two the game ships with. See `server/src/match/composure/`. */
export const COMPOSURE_KINDS = {
  /** Tap out a slow breath against your own racing heart. */
  BREATH: 'BREATH',
  /** Hold your breath for just as long as you were shown, and let it go. */
  HOLD: 'HOLD',
} as const;

/** The two raw inputs a challenge receives: a key going down, and coming up. */
export const COMPOSURE_INPUTS = ['DOWN', 'UP'] as const;
export type ComposureInput = (typeof COMPOSURE_INPUTS)[number];

export const COMPOSURE = {
  /** After a result, how long before another challenge may be asked for. */
  cooldownMs: 15_000,
  /** Quality, 0..1, at or above which a challenge is a success. */
  passAt: 0.6,
  /**
   * How much of a seat's visible stress a success hides at first, at the worst
   * and the best quality that still passes. It fades to nothing over
   * `steadiedMs`.
   */
  steadiedHides: { atPass: 0.35, atBest: 0.8 },
  steadiedMs: 30_000,
  /**
   * How much worse a failure makes a seat look at first, as a share of the
   * headroom between their stress and the top of the scale. Fades over
   * `shakenMs`, which is shorter: a stumble is noticed and then forgotten.
   */
  shakenAdds: 0.3,
  shakenMs: 12_000,
} as const;

/**
 * A challenge's public parameters, for its owner to draw.
 *
 * Numbers only, by construction. A spec is whatever a kind needs to show its
 * player — a rhythm, a duration — and it is held to finite numbers and arrays
 * of them so that nothing else can ride along in it.
 */
export type ComposureSpec = Record<string, number | number[]>;

export interface ComposureChallengeView {
  id: string;
  kind: ComposureKind;
  spec: ComposureSpec;
  /** Server time it was issued, and when it lapses if not finished. */
  issuedAt: number;
  expiresAt: number;
}

export type ComposureOutcome = 'STEADIED' | 'SHAKEN';

export interface ComposureResultView {
  outcome: ComposureOutcome;
  /** How well it went, 0..1. */
  quality: number;
  /** When the effect on your tells has worn off. */
  until: number;
}

/** Everything a player is told about their own composure. Owner-only. */
export interface ComposureView {
  /** The challenge in progress, if any. */
  challenge: ComposureChallengeView | null;
  /** The last result, while its effect lasts. */
  result: ComposureResultView | null;
  /** Server time from which another challenge may be asked for. */
  readyAt: number;
}

export const NO_COMPOSURE: ComposureView = { challenge: null, result: null, readyAt: 0 };
