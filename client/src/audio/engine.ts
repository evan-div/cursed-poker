import type { PerspectiveCamera } from 'three';
import { blend } from '@cursed/shared';
import type { Cue, CueKind } from './cues.js';

/**
 * The part that actually makes noise.
 *
 * Deliberately thin, and deliberately the only file here that touches the
 * browser: what a sound *means* lives in `cues.ts`, where it can be tested.
 * This turns a cue into air.
 *
 * Nothing is loaded. Every sound is synthesised at start-up into a short buffer,
 * the same way the card atlas is drawn at start-up rather than shipped — no
 * assets to version, no fetch to fail, and the whole palette changes by editing
 * numbers. It also suits what these are: none of them is music. A card landing
 * on felt is filtered noise with a fast envelope, and so is almost everything
 * else in a room like this.
 *
 * **Audio waits for a gesture.** Browsers refuse to start an `AudioContext`
 * until the user has clicked something, and a context created too early is
 * created suspended and stays that way silently. So this is constructed only
 * when asked, from inside a real click, and everything before that point is a
 * no-op rather than an error.
 */

/** How the room is mixed. Everything is quiet; the room is supposed to be. */
const MIX = {
  master: 0.55,
  /** The room tone under everything, at no dread and at full. */
  tone: { calm: 0.035, dread: 0.16 },
  /** Distance at which a cue is at full volume, in metres. */
  refDistance: 0.7,
  /** How fast it falls off past that. */
  rolloff: 1.4,
  /**
   * Your own body, which is not in the room.
   *
   * Unpanned and unattenuated: a heartbeat does not come from a direction. And
   * mixed under the table, never over it — a chip pushed in across the felt has
   * to stay audible through it, because that sound is information and this one
   * is only fear.
   */
  body: 0.5,
} as const;

/** Sample rate of the synthesised buffers. Cheap, and nothing here is music. */
const RATE = 44_100;

export interface RoomAudio {
  /** True once a real `AudioContext` is running. */
  readonly running: boolean;
  /** Points the listener at whatever the player is looking at. */
  follow(camera: PerspectiveCamera): void;
  /** Plays one cue, positioned in the room. */
  play(cue: Cue): void;
  /** How bad the room has got, 0..1. Drives the tone under everything. */
  setDread(level: number): void;
  /** One beat of your own heart: lub, and `gap` seconds later, dub. */
  heartbeat(gain: number, gap: number): void;
  /** One breath in, heard from the inside. */
  breath(gain: number): void;
  close(): Promise<void>;
}

/**
 * Silence, for every path that has not been through a click yet.
 *
 * A null object rather than an optional, so no caller anywhere has to remember
 * that audio might not exist. Everything can just talk to the room.
 */
export const SILENT_ROOM: RoomAudio = {
  running: false,
  follow() {},
  play() {},
  setDread() {},
  heartbeat() {},
  breath() {},
  async close() {},
};

/**
 * Starts the audio. Must be called from inside a user gesture.
 *
 * Returns `SILENT_ROOM` rather than throwing if the browser has no Web Audio at
 * all: a game that will not start because it cannot make a noise would be a
 * poor trade.
 */
export function startRoomAudio(): RoomAudio {
  const Ctor: typeof AudioContext | undefined =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return SILENT_ROOM;

  const context = new Ctor();
  void context.resume();

  const master = context.createGain();
  master.gain.value = MIX.master;
  master.connect(context.destination);

  const buffers = new Map<CueKind, AudioBuffer>();
  for (const [kind, make] of Object.entries(RECIPES) as [CueKind, Recipe][]) {
    buffers.set(kind, render(context, make));
  }

  // The room tone: filtered noise, looping, with nothing in it that resolves.
  const tone = context.createGain();
  tone.gain.value = MIX.tone.calm;
  tone.connect(master);
  const hum = context.createBufferSource();
  hum.buffer = render(context, roomTone);
  hum.loop = true;
  const humFilter = context.createBiquadFilter();
  humFilter.type = 'lowpass';
  humFilter.frequency.value = 320;
  hum.connect(humFilter).connect(tone);
  hum.start();

  const body = context.createGain();
  body.gain.value = MIX.body;
  body.connect(master);
  const lub = render(context, thump(0.32, 52, 0.075));
  const dub = render(context, thump(0.26, 61, 0.06));
  const inhale = render(context, breathIn);

  /** Plays a buffer straight into the head, at `when` on the audio clock. */
  const inside = (buffer: AudioBuffer, gain: number, when: number) => {
    const source = context.createBufferSource();
    source.buffer = buffer;
    const level = context.createGain();
    level.gain.value = gain;
    source.connect(level).connect(body);
    source.start(when);
    source.onended = () => source.disconnect();
  };

  return {
    get running() {
      return context.state === 'running';
    },

    follow(camera: PerspectiveCamera): void {
      const listener = context.listener;
      camera.updateMatrixWorld();
      const { x, y, z } = camera.position;
      // A camera looks down its own -Z, which is the convention Web Audio's
      // listener orientation already uses, so forward passes through unchanged.
      const m = camera.matrixWorld.elements;
      const forward = { x: -m[8]!, y: -m[9]!, z: -m[10]! };
      const up = { x: m[4]!, y: m[5]!, z: m[6]! };

      if (listener.positionX) {
        listener.positionX.value = x;
        listener.positionY.value = y;
        listener.positionZ.value = z;
        listener.forwardX.value = forward.x;
        listener.forwardY.value = forward.y;
        listener.forwardZ.value = forward.z;
        listener.upX.value = up.x;
        listener.upY.value = up.y;
        listener.upZ.value = up.z;
      } else {
        // Safari, and anything else still on the deprecated setters.
        listener.setPosition?.(x, y, z);
        listener.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
      }
    },

    play(cue: Cue): void {
      const buffer = buffers.get(cue.kind);
      if (!buffer || context.state !== 'running') return;

      const source = context.createBufferSource();
      source.buffer = buffer;
      // A little detune each time, so twenty chips in a row are twenty sounds
      // rather than one sound played twenty times.
      source.playbackRate.value = 0.9 + Math.random() * 0.2;

      const gain = context.createGain();
      gain.gain.value = cue.gain;

      const panner = context.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = MIX.refDistance;
      panner.rolloffFactor = MIX.rolloff;
      panner.positionX.value = cue.at.x;
      panner.positionY.value = cue.at.y;
      panner.positionZ.value = cue.at.z;

      source.connect(gain).connect(panner).connect(master);
      source.start();
      source.onended = () => source.disconnect();
    },

    setDread(level: number): void {
      const wanted = blend(MIX.tone.calm, MIX.tone.dread, level);
      tone.gain.setTargetAtTime(wanted, context.currentTime, 3);
      // The tone gets lower as well as louder, which is what makes it press
      // rather than just intrude.
      humFilter.frequency.setTargetAtTime(blend(320, 140, level), context.currentTime, 3);
    },

    heartbeat(gain: number, gap: number): void {
      if (context.state !== 'running' || !(gain > 0)) return;
      const now = context.currentTime;
      inside(lub, gain, now);
      inside(dub, gain * 0.7, now + Math.max(0.08, gap));
    },

    breath(gain: number): void {
      if (context.state !== 'running' || !(gain > 0)) return;
      inside(inhale, gain, context.currentTime);
    },

    async close(): Promise<void> {
      hum.stop();
      await context.close();
    },
  };
}

/** A recipe writes one channel of samples, and says how long it needs. */
interface Recipe {
  seconds: number;
  fill(sample: (t: number) => number, rate: number): (index: number) => number;
}

function render(context: BaseAudioContext, recipe: Recipe): AudioBuffer {
  const length = Math.max(1, Math.round(recipe.seconds * RATE));
  const buffer = context.createBuffer(1, length, RATE);
  const data = buffer.getChannelData(0);
  const at = recipe.fill((t) => t, RATE);
  for (let i = 0; i < length; i++) data[i] = at(i / RATE);
  return buffer;
}

/** Noise shaped by an envelope — which is most of what a room sounds like. */
function burst(seconds: number, attack: number, decay: number, colour: number): Recipe {
  return {
    seconds,
    fill: () => {
      let low = 0;
      return (t: number) => {
        const white = Math.random() * 2 - 1;
        // A one-pole lowpass, run in the time domain: `colour` near 1 is dark.
        low += (white - low) * (1 - colour);
        const rise = Math.min(t / attack, 1);
        const fall = Math.exp(-t / decay);
        return low * rise * fall;
      };
    },
  };
}

/** A hard little transient with a pitch to it: chip on chip. */
function tick(seconds: number, frequency: number, decay: number): Recipe {
  return {
    seconds,
    fill: () => (t: number) => {
      const body = Math.sin(2 * Math.PI * frequency * t);
      const grit = (Math.random() * 2 - 1) * 0.5;
      return (body + grit) * Math.exp(-t / decay);
    },
  };
}

/** Something heavy and slow, well below where a voice sits. */
function groan(seconds: number, frequency: number): Recipe {
  return {
    seconds,
    fill: () => (t: number) => {
      const slide = frequency * (1 - t / (seconds * 3));
      const body = Math.sin(2 * Math.PI * slide * t);
      const air = (Math.random() * 2 - 1) * 0.25;
      const shape = Math.min(t / 0.08, 1) * Math.exp(-t / (seconds * 0.5));
      return (body * 0.8 + air) * shape;
    },
  };
}

/**
 * A heart sound: felt more than heard.
 *
 * A low sine that sags in pitch as it dies, with a little dark noise for the
 * knock of it. Well under where anything at the table sits, so it presses on
 * the mix rather than competing with it.
 */
function thump(seconds: number, frequency: number, decay: number): Recipe {
  return {
    seconds,
    fill: () => {
      let low = 0;
      let phase = 0;
      return (t: number) => {
        phase += (2 * Math.PI * frequency * (1 - 0.35 * Math.min(t / decay, 1))) / RATE;
        low += (Math.random() * 2 - 1 - low) * 0.04;
        const shape = Math.min(t / 0.004, 1) * Math.exp(-t / decay);
        return (Math.sin(phase) + low * 1.5) * shape;
      };
    },
  };
}

/** Air drawn in through a tight throat. Slow in, quicker out. */
const breathIn: Recipe = {
  seconds: 1.1,
  fill: () => {
    let low = 0;
    let lower = 0;
    return (t: number) => {
      const white = Math.random() * 2 - 1;
      // Two poles, differenced: a crude band-pass that keeps the hiss of it and
      // loses both the rumble and the fizz.
      low += (white - low) * 0.35;
      lower += (low - lower) * 0.06;
      const band = low - lower;
      const shape = Math.sin(Math.PI * Math.min(t / 1.1, 1)) ** 2;
      return band * shape * 1.6;
    };
  },
};

const roomTone: Recipe = {
  // Long enough that the loop point is not a rhythm anybody could learn.
  seconds: 7.3,
  fill: () => {
    let low = 0;
    return () => {
      low += (Math.random() * 2 - 1 - low) * 0.02;
      return low * 3;
    };
  },
};

/**
 * What each cue is made of.
 *
 * All of it is noise and envelopes. A card landing on felt has no pitch; a chip
 * has a little; whatever the Dealer does when he stands has rather too much.
 */
const RECIPES: Record<CueKind, Recipe> = {
  DEAL: burst(0.16, 0.001, 0.035, 0.72),
  BOARD: burst(0.22, 0.001, 0.055, 0.6),
  CHIPS: tick(0.18, 2_400, 0.028),
  MUCK: burst(0.26, 0.002, 0.07, 0.82),
  POT: burst(0.7, 0.02, 0.22, 0.88),
  DEALER_RISE: groan(1.6, 46),
  ELIMINATION: groan(2.4, 33),
};
