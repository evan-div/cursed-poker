import { STRESS, tellCurves, type SelfStress } from '@cursed/shared';

/**
 * Your own body, felt from the inside.
 *
 * The server says how stressed you are, a few times a second, and only to you.
 * This turns that one number into the things a frightened person actually
 * experiences: a heartbeat you can hear, breath you can see rising and falling
 * in your own view, hands that will not hold still, and the edges of the room
 * going dark.
 *
 * ## What it is allowed to touch
 *
 * Everything here is **local and cosmetic**, and it is worth being precise about
 * why that matters, because two of the outputs sit right next to things that
 * are replicated.
 *
 *   - **The camera shakes, but your gaze does not.** Gaze is reported to the
 *     table. If it were resolved from the shaken camera, a trembling player's
 *     reported target would flicker between neighbours, and the flicker rate
 *     would be a high-resolution readout of their tremor — exactly what the
 *     server quantises the broadcast tell to prevent. `SeatedCamera` resolves
 *     gaze from where you *meant* to look.
 *   - **Your peek gets harder, but your peek is not jittered.** Exposure is
 *     replicated. Shaking it would broadcast tremor at frame rate. Instead the
 *     same look costs more pointer travel, so a shaking player works harder to
 *     read their cards — in front of everybody, which is the tell the table
 *     already gets.
 *
 * And the input is only ever the player's own stress, which the server built
 * from public facts. Nothing here can learn anything about anybody else.
 *
 * Pure and clocked by the caller, so the feel is testable and a replay of the
 * same frames lands on the same body.
 */

export const FEEL = {
  /** How quickly the felt stress catches up with the reported one, in seconds. */
  easeSeconds: 0.45,
  /** Breaths per minute at rest and at panic. */
  breathsPerMinute: { calm: 11, panic: 32 },
  /** Below this, a heartbeat is something you have, not something you hear. */
  audibleFrom: 0.3,
  /** Loudest the heartbeat gets, as a cue gain. */
  maxBeatGain: 0.9,
  /** Breathing becomes audible above this much breathing tell. */
  audibleBreathFrom: 0.55,
  /** Peak tremor of the head, in radians. About half a degree: seen, not sickening. */
  tremorRadians: 0.009,
  /** Pitch sway from breathing, in radians, at rest and at panic. */
  breathRadians: { calm: 0.0015, panic: 0.011 },
  /** How hard a heartbeat knocks the view at full stress, in radians. */
  beatKickRadians: 0.004,
  /** The vignette never closes past this, so the middle of the table is always there. */
  maxTunnel: 0.94,
  /** Where tunnel vision starts and where it is full. */
  tunnelFrom: 0.42,
  /** How much of the tunnel throbs with the pulse. */
  tunnelThrob: 0.16,
  /** Where the second heart sound lands, as a fraction of the beat, and its cap. */
  dubFraction: 0.32,
  dubMaxSeconds: 0.3,
} as const;

/** What the frame loop reads every frame. */
export interface Felt {
  /** The stress being felt right now, eased, 0..1. */
  stress: number;
  /** Beats per minute, unrounded. */
  heartRate: number;
  /** Head rotation to add on top of where the player is looking, in radians. */
  shake: { yaw: number; pitch: number; roll: number };
  /** How far the edges of the view have closed in, 0..1. */
  tunnel: number;
  /** How much the player's hands get in the way of their own peek, 0..1. */
  unsteadiness: number;
  /** The heart's own envelope, 0..1: high on the beat, falling between. */
  pulse: number;
}

/** Something to hear, fired by `update` on the frame it happens. */
export type FeltSound =
  | { kind: 'HEARTBEAT'; gain: number; /** Seconds from lub to dub. */ gap: number }
  | { kind: 'BREATH'; gain: number };

export interface PulseOptions {
  /** True for a player who has asked the OS for less motion. */
  reducedMotion?: boolean;
  /** Fixes the tremor's phases, for tests. */
  seed?: number;
}

const CALM_FELT: Felt = {
  stress: 0,
  heartRate: STRESS.restingBpm,
  shake: { yaw: 0, pitch: 0, roll: 0 },
  tunnel: 0,
  unsteadiness: 0,
  pulse: 0,
};

export class Pulse {
  #target = 0;
  #targetAt = Number.NEGATIVE_INFINITY;
  #stress = 0;
  #override: number | null = null;

  #beatPhase = 0;
  #breathPhase = 0;
  #time = 0;
  #reducedMotion: boolean;
  #phases: number[];
  #felt: Felt = { ...CALM_FELT, shake: { ...CALM_FELT.shake } };

  constructor(options: PulseOptions = {}) {
    this.#reducedMotion = options.reducedMotion ?? false;
    // Tremor is a few incommensurate wobbles summed: close enough to a real
    // hand's 8–12Hz shake, and never a rhythm anybody could lock on to.
    let seed = (options.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
    this.#phases = Array.from({ length: 6 }, () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return (seed / 2 ** 32) * Math.PI * 2;
    });
  }

  get felt(): Felt {
    return this.#felt;
  }

  /** The server's latest word, before easing — or the forced level, if forced. */
  get reported(): number {
    return this.#override ?? this.#target;
  }

  set reducedMotion(value: boolean) {
    this.#reducedMotion = value;
  }

  /**
   * The server's word on how you are.
   *
   * It arrives on two channels — inside every view, and on its own private
   * tick — and they can land out of order. The newer one wins; an older one is
   * a heart you no longer have.
   */
  setStress(stress: SelfStress, serverTime: number): void {
    if (serverTime < this.#targetAt) return;
    this.#targetAt = serverTime;
    this.#target = clamp01(stress.stress);
  }

  /**
   * Forces a stress level, or `null` to hand control back to the server.
   *
   * Development only, for screenshots and for tuning: it is the only way to see
   * what full panic looks like without spending a match getting there.
   */
  force(stress: number | null): void {
    this.#override = stress === null ? null : clamp01(stress);
  }

  /** Advances the body by one frame. Returns whatever there was to hear. */
  update(deltaSeconds: number): FeltSound[] {
    const dt = Number.isFinite(deltaSeconds) ? Math.min(Math.max(deltaSeconds, 0), 0.25) : 0;
    this.#time += dt;
    const sounds: FeltSound[] = [];

    const target = this.#override ?? this.#target;
    // Eased, because the channel is four hertz and a heart is not a staircase.
    this.#stress += (target - this.#stress) * (1 - Math.exp(-dt / FEEL.easeSeconds));
    const s = this.#stress;
    const curves = tellCurves(s);

    // The heart.
    const heartRate = STRESS.restingBpm + (STRESS.maxBpm - STRESS.restingBpm) * s;
    const period = 60 / heartRate;
    this.#beatPhase += dt / period;
    if (this.#beatPhase >= 1) {
      this.#beatPhase %= 1;
      const loud = smoothstep(FEEL.audibleFrom, 1, s);
      if (loud > 0) {
        sounds.push({
          kind: 'HEARTBEAT',
          gain: loud * FEEL.maxBeatGain,
          gap: Math.min(FEEL.dubMaxSeconds, period * FEEL.dubFraction),
        });
      }
    }
    const pulse = heartEnvelope(this.#beatPhase, period);

    // The breath.
    const bpm = FEEL.breathsPerMinute.calm +
      (FEEL.breathsPerMinute.panic - FEEL.breathsPerMinute.calm) * curves.breathing;
    const before = this.#breathPhase;
    this.#breathPhase = (this.#breathPhase + (dt * bpm) / 60) % 1;
    if (this.#breathPhase < before && curves.breathing > FEEL.audibleBreathFrom) {
      sounds.push({
        kind: 'BREATH',
        gain: smoothstep(FEEL.audibleBreathFrom, 1, curves.breathing) * 0.5,
      });
    }
    const breath = Math.sin(this.#breathPhase * Math.PI * 2);

    // The head. Nothing at all for a player who asked the OS for stillness:
    // the vignette and the sound still tell them how they are.
    const motion = this.#reducedMotion ? 0 : 1;
    const t = this.#time;
    const p = this.#phases;
    const shaking = curves.tremor * curves.tremor * FEEL.tremorRadians * motion;
    const sway =
      (FEEL.breathRadians.calm + (FEEL.breathRadians.panic - FEEL.breathRadians.calm) * curves.breathing) *
      motion;
    const kick = pulse * s * s * FEEL.beatKickRadians * motion;

    const shake = this.#reducedMotion ? { yaw: 0, pitch: 0, roll: 0 } : {
      yaw: shaking * (0.6 * Math.sin(t * 52.1 + p[0]!) + 0.4 * Math.sin(t * 73.7 + p[1]!)),
      pitch:
        shaking * (0.6 * Math.sin(t * 61.3 + p[2]!) + 0.4 * Math.sin(t * 38.9 + p[3]!)) +
        sway * breath -
        kick,
      roll: shaking * 0.5 * (0.5 * Math.sin(t * 44.3 + p[4]!) + 0.5 * Math.sin(t * 29.1 + p[5]!)),
    };

    const closing = smoothstep(FEEL.tunnelFrom, 1, s);
    const throb = this.#reducedMotion ? 0 : pulse * closing * FEEL.tunnelThrob;
    const tunnel = Math.min(FEEL.maxTunnel, closing * (FEEL.maxTunnel - FEEL.tunnelThrob) + throb);

    this.#felt = {
      stress: s,
      heartRate,
      shake,
      tunnel,
      unsteadiness: curves.tremor,
      pulse,
    };
    return sounds;
  }
}

/**
 * Lub, then dub, then nothing until the next one.
 *
 * Measured in seconds rather than phase so a fast heart does not smear: each
 * sound is the same length however close together they come.
 */
export function heartEnvelope(phase: number, period: number): number {
  const since = phase * period;
  const dubAt = Math.min(FEEL.dubMaxSeconds, period * FEEL.dubFraction);
  const lub = Math.exp(-since / 0.07);
  const dub = since >= dubAt ? 0.6 * Math.exp(-(since - dubAt) / 0.06) : 0;
  return Math.min(1, lub + dub);
}

function smoothstep(from: number, to: number, value: number): number {
  const x = clamp01((value - from) / (to - from));
  return x * x * (3 - 2 * x);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
