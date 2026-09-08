import {
  Color,
  CylinderGeometry,
  FogExp2,
  Group,
  HemisphereLight,
  Mesh,
  PlaneGeometry,
  Object3D,
  PointLight,
  Scene,
  SpotLight,
  TorusGeometry,
} from 'three';
import { MATERIALS } from './materials.js';
import { RADIUS, STATION_COUNT, TABLE, facingCentreYaw, stationPoint } from './layout.js';
import { roundedBox } from './shapes.js';

/**
 * The room and the table.
 *
 * Everything is built from primitives at runtime: no models to load, nothing to
 * version, and the whole thing changes shape by editing numbers. It is a
 * placeholder in fidelity but not in layout — the dimensions are the ones the
 * rest of the game measures against, so cards, chips and hands all land where
 * they should.
 *
 * Lighting is deliberately thin: one shadow-casting lamp over the table and
 * almost nothing else, with heavy fog swallowing the rest. That is the Phase 3
 * budget and the Phase 5 starting point — the room should already feel like it
 * ends a few metres away.
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
  /** Exponential fog. Small numbers, large consequences. */
  fog: { calm: 0.26, dread: 0.46 },
  /** The trace of bounce that keeps faces off pure silhouette. */
  bounce: { calm: 0.32, dread: 0.12 },
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

  const group = new Group();
  group.add(buildFloor(), buildTable(), buildChairs());

  // The one real light: a lamp over the felt. Its cone has to reach past the
  // rail to the people sitting at it — a tighter pool lights the hands and
  // leaves six pairs of disembodied arms in the dark, which looks like a bug
  // rather than like dread.
  const lamp = new SpotLight(ROOM.lampColour.calm, ROOM.lamp.calm, 6.5, ROOM.cone.calm, 0.45, 1.3);
  lamp.position.set(0, 1.88, 0);
  lamp.target.position.set(0, TABLE.surfaceHeight, 0);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.camera.near = 0.4;
  lamp.shadow.camera.far = 4.5;
  lamp.shadow.bias = -0.0008;
  group.add(lamp, lamp.target, buildLampFixture());

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
    },
  };
}

function mix(calm: number, dread: number, level: number): number {
  return calm + (dread - calm) * level;
}

function buildFloor(): Mesh {
  const floor = new Mesh(new PlaneGeometry(14, 14), MATERIALS.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  return floor;
}

function buildTable(): Group {
  const table = new Group();

  const feltThickness = 0.03;
  const felt = new Mesh(
    new CylinderGeometry(TABLE.feltRadius, TABLE.feltRadius, feltThickness, 64),
    MATERIALS.felt,
  );
  felt.position.y = TABLE.surfaceHeight - feltThickness / 2;
  felt.receiveShadow = true;
  table.add(felt);

  // The padded rail players rest their arms on.
  const railTube = (TABLE.railRadius - TABLE.feltRadius) / 2;
  const rail = new Mesh(
    new TorusGeometry(TABLE.feltRadius + railTube, railTube, 20, 96),
    MATERIALS.rail,
  );
  rail.rotation.x = -Math.PI / 2;
  rail.position.y = TABLE.surfaceHeight - feltThickness / 2;
  rail.castShadow = true;
  rail.receiveShadow = true;
  table.add(rail);

  const skirtHeight = 0.16;
  const skirt = new Mesh(
    new CylinderGeometry(TABLE.railRadius - 0.01, TABLE.railRadius - 0.05, skirtHeight, 64),
    MATERIALS.wood,
  );
  skirt.position.y = TABLE.surfaceHeight - feltThickness - skirtHeight / 2;
  skirt.castShadow = true;
  table.add(skirt);

  const columnHeight = TABLE.surfaceHeight - feltThickness - skirtHeight;
  const column = new Mesh(new CylinderGeometry(0.11, 0.16, columnHeight, 40), MATERIALS.wood);
  column.position.y = columnHeight / 2;
  column.castShadow = true;
  table.add(column);

  const base = new Mesh(new CylinderGeometry(0.42, 0.46, 0.035, 48), MATERIALS.wood);
  base.position.y = 0.018;
  base.receiveShadow = true;
  table.add(base);

  return table;
}

/** One chair per station, the Dealer's included. Chairs outlive their occupants. */
function buildChairs(): Group {
  const chairs = new Group();
  // One geometry each, shared across all seven chairs.
  const seatGeometry = roundedBox(0.44, 0.05, 0.42);
  const backGeometry = roundedBox(0.44, 0.52, 0.05);
  const legGeometry = roundedBox(0.05, 0.44, 0.05);

  for (let station = 0; station < STATION_COUNT; station++) {
    const chair = new Group();
    const at = stationPoint(station, RADIUS.body + 0.12, 0);
    chair.position.set(at.x, 0, at.z);
    chair.rotation.y = facingCentreYaw(station);

    const seat = new Mesh(seatGeometry, MATERIALS.chair);
    seat.position.y = 0.45;
    seat.castShadow = true;
    seat.receiveShadow = true;

    const back = new Mesh(backGeometry, MATERIALS.chair);
    back.position.set(0, 0.72, -0.19);
    back.castShadow = true;

    chair.add(seat, back);
    for (const [x, z] of [
      [-0.18, -0.16],
      [0.18, -0.16],
      [-0.18, 0.16],
      [0.18, 0.16],
    ] as const) {
      const leg = new Mesh(legGeometry, MATERIALS.chair);
      leg.position.set(x, 0.22, z);
      chair.add(leg);
    }
    chairs.add(chair);
  }
  return chairs;
}

/** The lamp above the table: a shade, a filament, and the reason you can see. */
function buildLampFixture(): Group {
  const fixture = new Group();

  const cord = new Mesh(new CylinderGeometry(0.004, 0.004, 1.0, 6), MATERIALS.wood);
  cord.position.y = 2.44;
  fixture.add(cord);

  const shade = new Mesh(new CylinderGeometry(0.22, 0.1, 0.16, 40, 1, true), MATERIALS.brass);
  shade.position.y = 1.96;
  fixture.add(shade);

  const bulb = new Mesh(new CylinderGeometry(0.12, 0.12, 0.006, 20), MATERIALS.lampGlow);
  bulb.position.y = 1.88;
  fixture.add(bulb);

  return fixture;
}
