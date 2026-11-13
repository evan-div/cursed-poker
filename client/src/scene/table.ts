import { Color, FogExp2, Group, HemisphereLight, Object3D, PointLight, Scene, SpotLight } from 'three';
import { TABLE } from './layout.js';
import { buildChairs, buildTable } from './furniture.js';
import { LAMP_HEIGHT, buildLamp } from './lamp.js';
import { ROOM_HEIGHT, buildShell } from './room-shell.js';

/**
 * The room and the table, and the light they are seen by.
 *
 * Everything is still built at runtime from numbers: no models to load, nothing
 * to version, and the whole thing changes shape by editing them. What it is
 * built *out of* lives next door — `furniture.ts` for the table and chairs,
 * `room-shell.ts` for the walls and what hangs on them, `lamp.ts` for the shade
 * and the air under it. This file is the lighting, and the dial that turns it.
 *
 * Lighting is deliberately thin: one shadow-casting lamp over the table, a
 * breath of bounce, and two candles on the walls that will not last the
 * evening. The room should feel like it ends where the lamp does, and then
 * turn out not to.
 */

/**
 * The room, and the two dials it answers to.
 *
 * Lighting used to be a fixed placeholder — one lamp, some fill, enough to be
 * readable. It is now a *state*: the room gets worse as the match does, on the
 * server's number rather than on anything a client decides, so two players
 * never disagree about how dark it has got.
 */
export interface Room {
  group: Group;
  lamp: SpotLight;
  /** Shadow-casting lights, so the performance budget has something to count. */
  shadowLights: number;
  /** How bad the room has got, 0..1. Straight from the presence frame. */
  setDread(level: number): void;
  /**
   * How hard the local player is peering at something in their own hands, 0..1.
   *
   * See `READING_LIGHT` for why this exists and why it is not cheating.
   */
  setPeering(amount: number): void;
  /** Hangs the reading light off the thing that moves with the player's eyes. */
  attachTo(camera: Object3D): void;
  /** The drawing surface changed size, or the player leaned in. */
  setViewport(heightPixels: number, fovDegrees: number): void;
  /**
   * How much the room is allowed to cost. See `quality.ts`.
   *
   * On `low` the shaft of lit air and the dust go, the candles and the door
   * stop casting light and only glow, and the shadow map halves. The room keeps
   * its shape and loses its air.
   */
  setDetail(detail: 'high' | 'low'): void;
  update(delta: number): void;
}

/**
 * Where the room starts and where it ends up.
 *
 * The lamp does not simply dim. It dims, reddens and *narrows*: the pool of
 * light on the felt tightens and the people sitting around the edge of it go.
 * Dimming alone reads as a brightness slider; losing the edges of the room
 * reads as the room closing in, which is the thing the brief asks for.
 */
const ROOM = {
  lamp: { calm: 24, dread: 14 },
  /** Warm tungsten, souring toward something with blood in it. */
  lampColour: { calm: 0xffd2a0, dread: 0xff8f63 },
  /** Half-angle of the lamp cone, in radians. */
  cone: { calm: Math.PI / 2.5, dread: Math.PI / 3.4 },
  /**
   * Exponential fog. Small numbers, large consequences.
   *
   * Thinner than it was when there was nothing out there to hide. The room has
   * walls now, and at the start of the evening they should be findable; what
   * takes them away later is this number rising, which is the point of having
   * given the fog something to take.
   */
  fog: { calm: 0.12, dread: 0.36 },
  /** The trace of bounce that keeps faces off pure silhouette. */
  bounce: { calm: 0.5, dread: 0.14 },
  /** The warm fill at table height that keeps hands from going black. */
  fill: { calm: 1.5, dread: 0.75 },
  /**
   * Dread above which the lamp stops being steady.
   *
   * Not a flicker in the horror-film sense — no strobing, nothing that reads as
   * an effect. Just enough drift that a player who has been staring at the
   * table for an hour cannot quite be sure the light is holding still.
   */
  unsteadyAbove: 0.55,
  unsteadyAmount: 0.07,
} as const;

/**
 * A light that belongs to your own eyes, not to the room.
 *
 * The problem it solves, from the roadmap: **one lamp above the table leaves a
 * steeply tilted card in its own shadow.** A hole card has to rotate past
 * vertical before its face comes round toward its owner, and by then the
 * printed side is pointing away from the only light there is. No amount of
 * peeling helps; the card is turning into the dark.
 *
 * Brightening the room would fix it and ruin everything else. So this is not a
 * room light: it is a small, very short-range one carried at the player's own
 * eye, which comes up only while they are actually holding their cards up. It
 * reaches about as far as your hands and dies before it gets anywhere near the
 * felt, so it lights what you are peering at and changes nothing anybody else
 * can see.
 *
 * It also cannot leak: it exists on one client, it is driven by that client's
 * own gesture, and there is no information in it that its owner did not already
 * have. What the *table* sees is the replicated lift, exactly as before.
 */
/** The lamp's shadow map, by how much the room is allowed to cost. */
const SHADOW_MAP = { high: 2048, low: 1024 } as const;

const READING_LIGHT = {
  intensity: 0.85,
  /** Metres. Roughly arm's length, so the felt never sees it. */
  distance: 0.62,
  decay: 2.0,
  /** Down and forward from the eye, so it does not flatten the card it lights. */
  offset: { x: 0.06, y: -0.1, z: -0.12 },
} as const;

export function buildRoom(scene: Scene): Room {
  const fog = new FogExp2(0x070605, ROOM.fog.calm);
  scene.fog = fog;

  const shell = buildShell();
  const fixture = buildLamp(ROOM_HEIGHT);

  const group = new Group();
  group.add(shell.group, buildTable(), buildChairs(), fixture.group);

  // The one real light: a lamp over the felt. Its cone has to reach past the
  // rail to the people sitting at it — a tighter pool lights the hands and
  // leaves six pairs of disembodied arms in the dark, which looks like a bug
  // rather than like dread.
  const lamp = new SpotLight(ROOM.lampColour.calm, ROOM.lamp.calm, 6.5, ROOM.cone.calm, 0.45, 1.3);
  lamp.position.set(0, LAMP_HEIGHT - 0.02, 0);
  lamp.target.position.set(0, TABLE.surfaceHeight, 0);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(SHADOW_MAP.high, SHADOW_MAP.high);
  lamp.shadow.camera.near = 0.4;
  lamp.shadow.camera.far = 5.5;
  // A stack of chips is a wall three millimetres from the next wall. Offsetting
  // along the normal as well as in depth is what stops each one shadowing
  // itself in stripes — which is what every stack on the table used to do.
  lamp.shadow.bias = -0.0004;
  lamp.shadow.normalBias = 0.012;
  lamp.shadow.radius = 2.5;
  group.add(lamp, lamp.target);

  // A trace of bounce so faces are not pure silhouette. No shadows, no cost.
  const bounce = new HemisphereLight(0x2f2618, 0x090807, ROOM.bounce.calm);
  group.add(bounce);

  // A weak warm fill at table height keeps hands from going fully black.
  const fill = new PointLight(0xffb27a, ROOM.fill.calm, 3.0, 1.7);
  fill.position.set(0, TABLE.surfaceHeight + 0.35, 0);
  group.add(fill);

  const reading = new PointLight(
    0xffd9b0,
    0,
    READING_LIGHT.distance,
    READING_LIGHT.decay,
  );
  reading.position.set(READING_LIGHT.offset.x, READING_LIGHT.offset.y, READING_LIGHT.offset.z);

  scene.add(group);

  const warm = new Color(ROOM.lampColour.calm);
  const cold = new Color(ROOM.lampColour.dread);
  let dread = 0;
  let peering = 0;
  let shown = -1;
  let drift = 0;

  return {
    group,
    lamp,
    shadowLights: 1,

    setDread(level: number): void {
      dread = Math.min(Math.max(level, 0), 1);
    },

    setPeering(amount: number): void {
      peering = Math.min(Math.max(amount, 0), 1);
    },

    attachTo(camera: Object3D): void {
      camera.add(reading);
    },

    setViewport(heightPixels: number, fovDegrees: number): void {
      fixture.setViewport(heightPixels, fovDegrees);
    },

    setDetail(detail: 'high' | 'low'): void {
      const high = detail === 'high';
      fixture.setAir(high);
      shell.setLit(high);
      const size = high ? SHADOW_MAP.high : SHADOW_MAP.low;
      if (lamp.shadow.mapSize.x !== size) {
        lamp.shadow.mapSize.set(size, size);
        // The map is allocated once; a new size needs a new one.
        lamp.shadow.map?.dispose();
        lamp.shadow.map = null;
      }
    },

    update(delta: number): void {
      // The room turns slowly. Dread itself only moves when the match does, but
      // easing the *lighting* means an elimination darkens the room over a
      // couple of seconds rather than between two frames.
      shown = shown < 0 ? dread : shown + (dread - shown) * (1 - Math.exp(-0.7 * delta));

      drift += delta;
      const unsteady =
        shown <= ROOM.unsteadyAbove
          ? 0
          : ((shown - ROOM.unsteadyAbove) / (1 - ROOM.unsteadyAbove)) *
            ROOM.unsteadyAmount *
            // Two waves that do not share a period, so it never finds a rhythm
            // a player could start predicting.
            (Math.sin(drift * 1.7) * 0.6 + Math.sin(drift * 0.43) * 0.4);

      lamp.intensity = mix(ROOM.lamp.calm, ROOM.lamp.dread, shown) * (1 + unsteady);
      lamp.angle = mix(ROOM.cone.calm, ROOM.cone.dread, shown);
      lamp.color.copy(warm).lerp(cold, shown);
      fog.density = mix(ROOM.fog.calm, ROOM.fog.dread, shown);
      bounce.intensity = mix(ROOM.bounce.calm, ROOM.bounce.dread, shown);
      fill.intensity = mix(ROOM.fill.calm, ROOM.fill.dread, shown);

      reading.intensity = READING_LIGHT.intensity * peering;

      // The candles, the door, and the air the lamp shines through all follow
      // the same eased number, so nothing in the room turns before the rest.
      shell.update(delta, shown);
      fixture.update(delta, shown, lamp.color, 1 + unsteady);
    },
  };
}

function mix(calm: number, dread: number, level: number): number {
  return calm + (dread - calm) * level;
}
