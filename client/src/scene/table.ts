import {
  BoxGeometry,
  CylinderGeometry,
  FogExp2,
  Group,
  HemisphereLight,
  Mesh,
  PlaneGeometry,
  PointLight,
  Scene,
  SpotLight,
  TorusGeometry,
} from 'three';
import { MATERIALS } from './materials.js';
import { RADIUS, STATION_COUNT, TABLE, facingCentreYaw, stationPoint } from './layout.js';

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

export interface TableBuild {
  group: Group;
  lamp: SpotLight;
  /** Shadow-casting lights, so the performance budget has something to count. */
  shadowLights: number;
}

export function buildRoom(scene: Scene): TableBuild {
  scene.fog = new FogExp2(0x070605, 0.26);

  const group = new Group();
  group.add(buildFloor(), buildTable(), buildChairs());

  // The one real light: a lamp over the felt. Its cone has to reach past the
  // rail to the people sitting at it — a tighter pool lights the hands and
  // leaves six pairs of disembodied arms in the dark, which looks like a bug
  // rather than like dread.
  const lamp = new SpotLight(0xffd2a0, 24, 6.5, Math.PI / 2.5, 0.45, 1.3);
  lamp.position.set(0, 1.88, 0);
  lamp.target.position.set(0, TABLE.surfaceHeight, 0);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.camera.near = 0.4;
  lamp.shadow.camera.far = 4.5;
  lamp.shadow.bias = -0.0008;
  group.add(lamp, lamp.target, buildLampFixture());

  // A trace of bounce so faces are not pure silhouette. No shadows, no cost.
  const bounce = new HemisphereLight(0x2f2618, 0x090807, 0.32);
  group.add(bounce);

  // A weak warm fill at table height keeps hands from going fully black.
  const fill = new PointLight(0xffb27a, 1.5, 3.0, 1.7);
  fill.position.set(0, TABLE.surfaceHeight + 0.35, 0);
  group.add(fill);

  scene.add(group);
  return { group, lamp, shadowLights: 1 };
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
    new TorusGeometry(TABLE.feltRadius + railTube, railTube, 12, 64),
    MATERIALS.rail,
  );
  rail.rotation.x = -Math.PI / 2;
  rail.position.y = TABLE.surfaceHeight - feltThickness / 2;
  rail.castShadow = true;
  rail.receiveShadow = true;
  table.add(rail);

  const skirtHeight = 0.16;
  const skirt = new Mesh(
    new CylinderGeometry(TABLE.railRadius - 0.01, TABLE.railRadius - 0.05, skirtHeight, 48),
    MATERIALS.wood,
  );
  skirt.position.y = TABLE.surfaceHeight - feltThickness - skirtHeight / 2;
  skirt.castShadow = true;
  table.add(skirt);

  const columnHeight = TABLE.surfaceHeight - feltThickness - skirtHeight;
  const column = new Mesh(new CylinderGeometry(0.11, 0.16, columnHeight, 24), MATERIALS.wood);
  column.position.y = columnHeight / 2;
  column.castShadow = true;
  table.add(column);

  const base = new Mesh(new CylinderGeometry(0.42, 0.46, 0.035, 32), MATERIALS.wood);
  base.position.y = 0.018;
  base.receiveShadow = true;
  table.add(base);

  return table;
}

/** One chair per station, the Dealer's included. Chairs outlive their occupants. */
function buildChairs(): Group {
  const chairs = new Group();
  const seatGeometry = new BoxGeometry(0.44, 0.05, 0.42);
  const backGeometry = new BoxGeometry(0.44, 0.52, 0.05);
  const legGeometry = new BoxGeometry(0.05, 0.44, 0.05);

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

  const shade = new Mesh(new CylinderGeometry(0.22, 0.1, 0.16, 24, 1, true), MATERIALS.brass);
  shade.position.y = 1.96;
  fixture.add(shade);

  const bulb = new Mesh(new CylinderGeometry(0.12, 0.12, 0.006, 20), MATERIALS.lampGlow);
  bulb.position.y = 1.88;
  fixture.add(bulb);

  return fixture;
}
