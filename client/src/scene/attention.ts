/**
 * Where the game would like you to look.
 *
 * When somebody else's turn begins, your head drifts toward them — the way it
 * does when a person at a table starts to speak. It is emphatically *not* a
 * camera lock: it moves the place your head is heading, closes only part of the
 * gap, and the instant you move the mouse yourself it lets go completely and
 * stays gone for a couple of seconds.
 *
 * That last part is the whole design. A player who deliberately watches somebody
 * else while it is a third player's turn is doing something meaningful, and a
 * camera that dragged them back would destroy it. The bias exists to make you
 * *notice* things, never to decide what you look at.
 *
 * Pure state and arithmetic: no camera, no scene, no DOM.
 */

export interface AttentionPull {
  /** Yaw the head would drift to, in the same frame as the camera's own. */
  yaw: number;
  /** Pitch it would drift to. */
  pitch: number;
  /** 0..1. How hard the game is pulling, which decays over the event's life. */
  weight: number;
  /**
   * Where the player's head was aimed when this pull started.
   *
   * Kept so the bias can be bounded by *total* displacement rather than by
   * speed. Nudging a fraction of the remaining gap every frame is not a nudge:
   * over a second it arrives, and the head ends up locked onto whoever acted.
   */
  fromYaw: number | null;
  fromPitch: number | null;
  /** Epoch ms when this pull began. */
  startedAt: number;
  /** Epoch ms after which this pull is over. */
  until: number;
}

export interface AttentionOptions {
  /**
   * How long a deliberate look suppresses all bias.
   *
   * Long enough that looking away is a decision the game respects, short enough
   * that a player who then sits still is still shown the next thing that
   * matters.
   */
  overrideMs?: number;
  /** Pointer movement, in pixels, that counts as a deliberate look. */
  overridePixels?: number;
  /** Fraction of the remaining angle closed per second at full weight. */
  gainPerSecond?: number;
  /** The most the bias may turn a head in one second, in radians. */
  maxRadiansPerSecond?: number;
  /**
   * How much of the way to a subject the bias will ever go.
   *
   * Never all of it. The bias points your head; you finish the movement, or you
   * do not, and either way it was you.
   */
  maxClose?: number;
}

const DEFAULTS: Required<AttentionOptions> = {
  overrideMs: 2_400,
  overridePixels: 6,
  gainPerSecond: 1.8,
  maxRadiansPerSecond: 1.1,
  maxClose: 0.62,
};

/** Named so tuning reads as intent rather than as numbers. */
export const ATTENTION_WEIGHT = {
  /** Somebody else's turn began. The softest pull there is. */
  turn: 0.3,
  /** Cards coming out. */
  deal: 0.4,
  /** A large raise. */
  raise: 0.6,
  /** All in. */
  allIn: 0.85,
  /** A showdown, an elimination, the Dealer doing something. */
  reckoning: 1,
} as const;

export class AttentionDirector {
  #pull: AttentionPull | null = null;
  #suppressedUntil = 0;
  #options: Required<AttentionOptions>;

  constructor(options: AttentionOptions = {}) {
    this.#options = { ...DEFAULTS, ...options };
  }

  get pull(): AttentionPull | null {
    return this.#pull;
  }

  isSuppressed(now: number): boolean {
    return now < this.#suppressedUntil;
  }

  /**
   * Asks for the player's attention.
   *
   * A weaker pull never displaces a stronger one that is still running: an
   * all-in does not get bumped aside because the next player's turn began.
   */
  focus(yaw: number, pitch: number, weight: number, now: number, durationMs = 1_400): void {
    if (weight <= 0) return;
    if (this.#pull && now < this.#pull.until && this.#pull.weight > weight) return;

    // Asking for attention on the subject already being watched extends the
    // moment; it does not start a new one. Otherwise each repeat re-measures
    // its reach from wherever the last one left the head, and a subject that
    // keeps asking walks the player onto it a fraction at a time — which is the
    // unbounded lock this whole mechanism exists to avoid.
    const live = this.#pull;
    if (live && now < live.until && live.yaw === yaw && live.pitch === pitch) {
      live.until = now + Math.max(1, durationMs);
      return;
    }

    this.#pull = {
      yaw,
      pitch,
      weight: Math.min(weight, 1),
      // Filled in on the first frame, when the player's actual aim is known.
      fromYaw: null,
      fromPitch: null,
      startedAt: now,
      until: now + Math.max(1, durationMs),
    };
  }

  /**
   * The player moved their own head. Everything stops.
   *
   * Movement below the threshold is ignored so that pointer noise, a trackpad
   * resting under a palm, or the tail of an easing animation does not
   * permanently disable a system the player never touched.
   */
  interrupt(pixelsMoved: number, now: number): void {
    if (pixelsMoved < this.#options.overridePixels) return;
    this.#pull = null;
    this.#suppressedUntil = now + this.#options.overrideMs;
  }

  /** Clears the bias without suppressing it — for seat changes and new hands. */
  clear(): void {
    this.#pull = null;
  }

  /**
   * How far the head should drift this frame.
   *
   * Returns the delta to add to the player's own look target, bounded two ways:
   * by a believable turning speed, and — the one that matters — by how far this
   * pull is allowed to move the head *in total*. It aims at a point a fraction
   * of the way toward the subject and stops there. Getting this wrong is not
   * subtle: an unbounded nudge is a camera lock with extra steps, and it made
   * players stare at their neighbours while trying to look at their own cards.
   *
   * Zero when suppressed, expired, or already there.
   */
  step(
    currentYaw: number,
    currentPitch: number,
    deltaSeconds: number,
    now: number,
  ): { yaw: number; pitch: number } {
    const none = { yaw: 0, pitch: 0 };
    if (deltaSeconds <= 0) return none;
    if (this.isSuppressed(now)) return none;

    const pull = this.#pull;
    if (!pull) return none;
    if (now >= pull.until) {
      this.#pull = null;
      return none;
    }

    // Where the head was when this started, so the bound is measured from there.
    pull.fromYaw ??= currentYaw;
    pull.fromPitch ??= currentPitch;

    // As far as this pull is ever allowed to turn the head: part of the way,
    // never all of it. You finish the movement, or you do not, and either way
    // it was you.
    const reach = this.#options.maxClose * pull.weight;
    const wantedYaw = pull.fromYaw + (pull.yaw - pull.fromYaw) * reach;
    const wantedPitch = pull.fromPitch + (pull.pitch - pull.fromPitch) * reach;

    // Eased out over the pull's life, so attention arrives as a drift and
    // leaves without a snap.
    const remaining = (pull.until - now) / (pull.until - pull.startedAt);
    const gain = clamp01(this.#options.gainPerSecond * deltaSeconds) * clamp01(remaining);
    const cap = this.#options.maxRadiansPerSecond * deltaSeconds;

    return {
      yaw: limit((wantedYaw - currentYaw) * gain, cap),
      pitch: limit((wantedPitch - currentPitch) * gain, cap),
    };
  }
}

function limit(value: number, cap: number): number {
  return Math.min(Math.max(value, -cap), cap);
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
