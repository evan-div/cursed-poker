import {
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  SphereGeometry,
  SplineCurve,
  TorusGeometry,
  Vector2,
  type BufferAttribute,
  type BufferGeometry,
} from 'three';
import { MATERIALS } from './materials.js';
import { DEALER_STATION, RADIUS, STATION_COUNT, TABLE, facingCentreYaw, stationPoint } from './layout.js';
import { fuse, roundedBox, type Part } from './shapes.js';

/**
 * The table and the chairs round it.
 *
 * Still nothing loaded: every solid here is turned or welded at start-up from
 * the same numbers `layout.ts` gives everything else. What changed is the
 * vocabulary. The table used to be four cylinders and the chairs six boxes
 * each; now the pedestal is turned on a lathe, the rail is stitched hide with a
 * row of brass tacks under it, and a chair has legs that taper and a back that
 * leans.
 *
 * It is also cheaper than what it replaced. Furniture does not move, so each
 * material's worth of it is welded into a single mesh: seven chairs were
 * forty-two draw calls and are now two.
 */

/** How far the rail's centre line sits below the top of the felt. */
const RAIL_DROP = 0.015;

/**
 * The playing surface.
 *
 * A disc with its UVs laid out so the canvas in `textures.ts` *is* the table
 * seen from above, Dealer at the top: canvas x is world x and canvas y is world
 * z. Everything printed on the felt depends on that, so it is built here rather
 * than taken from a cylinder's end cap, whose UVs run the other way round.
 */
function buildFelt(): Mesh {
  const geometry = new CircleGeometry(TABLE.feltRadius, 96);
  // Lying flat turns the disc's +Y into world -Z, which is the mapping the
  // painter assumes: v = (1 - z / R) / 2, and the canvas's top row is v = 1.
  geometry.rotateX(-Math.PI / 2);
  const felt = new Mesh(geometry, MATERIALS.felt);
  felt.position.y = TABLE.surfaceHeight;
  felt.receiveShadow = true;
  return felt;
}

/** Swaps a solid's U and V, to run a grain along it instead of round it. */
function turnGrain(geometry: BufferGeometry): BufferGeometry {
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
  uv.needsUpdate = true;
  return geometry;
}

export function buildTable(): Group {
  const table = new Group();
  table.add(buildFelt());

  // The padded rail players rest their arms on. The leather runs once round
  // the tube, which is what puts the two seams on top of it: see
  // `leatherSurface`.
  const railTube = (TABLE.railRadius - TABLE.feltRadius) / 2;
  const railCentre = TABLE.surfaceHeight - RAIL_DROP;
  const rail = new Mesh(new TorusGeometry(TABLE.feltRadius + railTube, railTube, 24, 128), MATERIALS.rail);
  rail.rotation.x = -Math.PI / 2;
  rail.position.y = railCentre;
  rail.castShadow = true;
  rail.receiveShadow = true;
  table.add(rail);

  // The apron: a bent band of veneer with a moulding along its lower edge.
  const apron = new Mesh(
    new LatheGeometry(
      [
        new Vector2(0.2, 0.6),
        new Vector2(0.7, 0.6),
        new Vector2(0.728, 0.603),
        new Vector2(0.744, 0.613),
        new Vector2(0.744, 0.626),
        new Vector2(0.754, 0.636),
        new Vector2(0.754, railCentre - 0.004),
      ],
      96,
    ),
    MATERIALS.wood,
  );
  apron.castShadow = true;
  apron.receiveShadow = true;
  table.add(apron);

  // A row of tacks where the hide is pulled under and fixed.
  const tackCount = 96;
  const tacks = new InstancedMesh(new SphereGeometry(0.0052, 8, 6), MATERIALS.brass, tackCount);
  const placed = new Matrix4();
  for (let i = 0; i < tackCount; i++) {
    const angle = (i / tackCount) * Math.PI * 2;
    placed.makeScale(1, 1, 0.55);
    placed.premultiply(new Matrix4().makeRotationY(angle));
    placed.setPosition(Math.sin(angle) * 0.7565, railCentre - 0.014, Math.cos(angle) * 0.7565);
    tacks.setMatrixAt(i, placed);
  }
  tacks.instanceMatrix.needsUpdate = true;
  table.add(tacks);

  // The pedestal, turned: a foot, a vase, a collar.
  const profile = new SplineCurve([
    new Vector2(0.3, 0.075),
    new Vector2(0.17, 0.1),
    new Vector2(0.105, 0.17),
    new Vector2(0.084, 0.25),
    new Vector2(0.1, 0.33),
    new Vector2(0.138, 0.39),
    new Vector2(0.142, 0.43),
    new Vector2(0.11, 0.475),
    new Vector2(0.086, 0.515),
    new Vector2(0.1, 0.556),
    new Vector2(0.2, 0.6),
  ]).getPoints(44);
  const pedestal = new Mesh(
    turnGrain(
      new LatheGeometry(
        [
          new Vector2(0.455, 0),
          new Vector2(0.455, 0.028),
          new Vector2(0.44, 0.045),
          new Vector2(0.41, 0.052),
          new Vector2(0.395, 0.066),
          ...profile,
        ],
        56,
      ),
    ),
    MATERIALS.wood,
  );
  pedestal.castShadow = true;
  pedestal.receiveShadow = true;
  table.add(pedestal);

  return table;
}

// ---------------------------------------------------------------------------
// Chairs
// ---------------------------------------------------------------------------

/** How far a chair's back leans, in radians. */
const RAKE = 0.1;

interface ChairParts {
  wood: Part[];
  leather: Part[];
}

/**
 * One chair, in its own space: feet on the floor, facing +Z.
 *
 * `backHeight` is where the top rail sits. An ordinary chair's is a little
 * over a metre; his is nearly two, and that is the only difference between
 * them — it is the same chair, made for something taller.
 */
function chairParts(backHeight: number, pointed: boolean): ChairParts {
  const seatHeight = 0.445;
  const halfWidth = 0.195;
  const frontZ = 0.175;
  const backZ = -0.185;

  const leg = (x: number, z: number): Part => ({
    geometry: new CylinderGeometry(0.024, 0.015, seatHeight, 10),
    at: [x, seatHeight / 2, z],
  });

  // A back post leans from the seat up; everything hung on it leans with it.
  const postLength = backHeight - seatHeight;
  const onBack = (along: number): [number, number] => [
    seatHeight + Math.cos(RAKE) * along,
    backZ - Math.sin(RAKE) * along,
  ];
  const post = (x: number): Part => {
    const [y, z] = onBack(postLength / 2);
    return {
      geometry: new CylinderGeometry(0.019, 0.023, postLength, 10),
      at: [x, y, z],
      turn: [-RAKE, 0, 0],
    };
  };
  const finial = (x: number): Part => {
    const [y, z] = onBack(postLength + (pointed ? 0.07 : 0.02));
    return pointed
      ? { geometry: new ConeGeometry(0.026, 0.17, 8), at: [x, y, z], turn: [-RAKE, 0, 0] }
      : { geometry: new SphereGeometry(0.025, 10, 8), at: [x, y, z] };
  };
  const rail = (along: number, width: number, height: number): Part => {
    const [y, z] = onBack(along);
    return { geometry: roundedBox(width, height, 0.03), at: [0, y, z], turn: [-RAKE, 0, 0] };
  };

  const padHeight = postLength - 0.3;
  const [padY, padZ] = onBack(0.16 + padHeight / 2);

  return {
    wood: [
      leg(-halfWidth, frontZ),
      leg(halfWidth, frontZ),
      leg(-halfWidth, backZ),
      leg(halfWidth, backZ),
      post(-halfWidth),
      post(halfWidth),
      finial(-halfWidth),
      finial(halfWidth),
      { geometry: roundedBox(0.46, 0.05, 0.44), at: [0, seatHeight, -0.005] },
      rail(postLength - 0.04, 0.44, 0.085),
      rail(0.12, 0.4, 0.04),
      // Stretchers, low down, where a heel would hook.
      { geometry: roundedBox(0.02, 0.022, 0.34), at: [-halfWidth, 0.15, -0.005] },
      { geometry: roundedBox(0.02, 0.022, 0.34), at: [halfWidth, 0.15, -0.005] },
      { geometry: roundedBox(0.38, 0.022, 0.02), at: [0, 0.2, frontZ] },
    ],
    leather: [
      { geometry: roundedBox(0.41, 0.055, 0.39), at: [0, seatHeight + 0.04, 0] },
      { geometry: roundedBox(0.34, padHeight, 0.04), at: [0, padY, padZ + 0.012], turn: [-RAKE, 0, 0] },
    ],
  };
}

/**
 * One chair per station, the Dealer's included. Chairs outlive their occupants.
 *
 * His stands a little way back from the table. He is on his feet in front of
 * it, and has been since before anybody else sat down.
 */
export function buildChairs(): Group {
  const chairs = new Group();
  const wood: BufferGeometry[] = [];
  const leather: BufferGeometry[] = [];

  for (let station = 0; station < STATION_COUNT; station++) {
    const his = station === DEALER_STATION;
    const at = stationPoint(station, his ? RADIUS.body + 0.66 : RADIUS.body + 0.12, 0);
    const place = new Matrix4().makeRotationY(facingCentreYaw(station)).setPosition(at.x, 0, at.z);
    const parts = chairParts(his ? 1.92 : 1.04, his);
    wood.push(fuse(parts.wood, place));
    leather.push(fuse(parts.leather, place));
  }

  const frames = new Mesh(fuse(wood.map((geometry) => ({ geometry }))), MATERIALS.chair);
  const pads = new Mesh(fuse(leather.map((geometry) => ({ geometry }))), MATERIALS.chairLeather);
  for (const mesh of [frames, pads]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  chairs.add(frames, pads);
  return chairs;
}
