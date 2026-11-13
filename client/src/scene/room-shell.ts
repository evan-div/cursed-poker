import {
  CircleGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  SphereGeometry,
  Vector2,
  type BufferAttribute,
  type BufferGeometry,
} from 'three';
import { BOUNCE_LIT, MATERIALS } from './materials.js';
import { fuse, roundedBox, type Part } from './shapes.js';
import { portraitTexture } from './textures.js';

/**
 * The room the table is in.
 *
 * There did not use to be one. The table stood on a floor that ran out into
 * fog, which is atmospheric for about a minute and then reads as what it is: a
 * table in a void. A room has corners for the dark to collect in, a door for
 * something to be behind, and walls that the lamp does not quite reach — and
 * when the fog thickens later in the evening there is finally something for it
 * to take away.
 *
 * Nothing here is furniture anybody uses. It is panelling to waist height,
 * paper above it, a door at the Dealer's back, four portraits somebody has
 * taken against, a sideboard, drapes, and two candles on the walls. All of it
 * is welded by material, so the whole shell is a dozen draw calls.
 *
 * The lights it owns are deliberately few and small: two flames and whatever is
 * coming under the door. They exist to be *lost*. As the room's dread rises the
 * candles go out one at a time and the door gets brighter, and nobody is told.
 */

/** Half the room's width, wall to wall. The table is in the middle of it. */
export const ROOM_HALF = 3.3;
export const ROOM_HEIGHT = 2.9;
/** Where the panelling stops and the paper starts. */
const DADO = 1.02;

/** The four walls, as a turn about the vertical and a place to stand each. */
const WALLS: readonly { yaw: number; x: number; z: number }[] = [
  { yaw: 0, x: 0, z: -ROOM_HALF }, // far: behind the Dealer
  { yaw: Math.PI, x: 0, z: ROOM_HALF }, // near
  { yaw: Math.PI / 2, x: -ROOM_HALF, z: 0 }, // left
  { yaw: -Math.PI / 2, x: ROOM_HALF, z: 0 }, // right
];

/** A transform that takes wall-local space (x along, y up, z out) to the room. */
function wallMatrix(wall: { yaw: number; x: number; z: number }): Matrix4 {
  return new Matrix4().makeRotationY(wall.yaw).setPosition(wall.x, 0, wall.z);
}

const FAR = wallMatrix(WALLS[0]!);
const NEAR = wallMatrix(WALLS[1]!);
const LEFT = wallMatrix(WALLS[2]!);
const RIGHT = wallMatrix(WALLS[3]!);

function plane(width: number, height: number): BufferGeometry {
  return new PlaneGeometry(width, height);
}

/** Scales a plane's UVs so a tiling surface keeps its size whatever the wall's. */
function tiled(geometry: BufferGeometry, u: number, v: number): BufferGeometry {
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  return geometry;
}

// ---------------------------------------------------------------------------

function buildFloor(): Group {
  const group = new Group();

  const floor = new Mesh(plane(ROOM_HALF * 2, ROOM_HALF * 2), MATERIALS.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;

  // Under the table and everybody's feet: the one soft thing in the room.
  const rugGeometry = new CircleGeometry(1.95, 72);
  rugGeometry.rotateX(-Math.PI / 2);
  const rug = new Mesh(rugGeometry, MATERIALS.rug);
  rug.position.y = 0.004;
  rug.receiveShadow = true;

  const ceiling = new Mesh(plane(ROOM_HALF * 2, ROOM_HALF * 2), MATERIALS.plaster);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_HEIGHT;

  group.add(floor, rug, ceiling);
  return group;
}

function buildWalls(): Group {
  const group = new Group();
  const width = ROOM_HALF * 2;

  // Paper above the dado, one sheet a wall.
  const paperHeight = ROOM_HEIGHT - DADO;
  const paper = fuse(
    WALLS.map((wall) => ({
      geometry: fuse([{ geometry: plane(width, paperHeight), at: [0, DADO + paperHeight / 2, 0] }], wallMatrix(wall)),
    })),
  );
  group.add(new Mesh(paper, MATERIALS.wallpaper));

  // Panelling below it: a flat board, stiles standing proud of it, a cap rail
  // along the top and a skirting along the bottom. The recesses between the
  // stiles are what the lamp finds.
  const panelling: BufferGeometry[] = [];
  const stileEvery = 0.66;
  for (const wall of WALLS) {
    const parts: Part[] = [
      { geometry: tiled(plane(width, DADO), 5, 1), at: [0, DADO / 2, 0.004] },
      { geometry: roundedBox(width, 0.06, 0.07), at: [0, DADO, 0.03] },
      { geometry: roundedBox(width, 0.15, 0.04), at: [0, 0.075, 0.02] },
      { geometry: roundedBox(width, 0.07, 0.022), at: [0, DADO - 0.11, 0.012] },
      { geometry: roundedBox(width, 0.07, 0.022), at: [0, 0.2, 0.012] },
      // The picture rail and the cornice, up where nobody looks.
      { geometry: roundedBox(width, 0.045, 0.035), at: [0, ROOM_HEIGHT - 0.42, 0.016] },
      { geometry: roundedBox(width, 0.12, 0.1), at: [0, ROOM_HEIGHT - 0.06, 0.05] },
    ];
    for (let x = -ROOM_HALF + stileEvery / 2; x < ROOM_HALF; x += stileEvery) {
      parts.push({ geometry: roundedBox(0.075, DADO - 0.3, 0.022), at: [x, DADO / 2 + 0.045, 0.012] });
    }
    panelling.push(fuse(parts, wallMatrix(wall)));
  }
  const wainscot = new Mesh(fuse(panelling.map((geometry) => ({ geometry }))), MATERIALS.wainscot);
  wainscot.receiveShadow = true;
  group.add(wainscot);

  return group;
}

/**
 * The door at his back.
 *
 * Shut, or near enough. What matters is the light round the edges of it, which
 * is the wrong colour for a hallway and is the only cold thing in the room.
 * Standing between it and the table is what gives him an outline.
 */
function buildDoor(): { group: Group; light: PointLight; glow: MeshStandardMaterial } {
  const group = new Group();
  const doorWidth = 0.94;
  const doorHeight = 2.08;

  const wood = fuse(
    [
      // The leaf, with four sunk panels suggested by the rails across it.
      { geometry: roundedBox(doorWidth, doorHeight, 0.045), at: [0, doorHeight / 2 + 0.012, 0.05] },
      { geometry: roundedBox(doorWidth - 0.16, 0.05, 0.02), at: [0, 0.3, 0.078] },
      { geometry: roundedBox(doorWidth - 0.16, 0.05, 0.02), at: [0, 1.02, 0.078] },
      { geometry: roundedBox(doorWidth - 0.16, 0.05, 0.02), at: [0, 1.86, 0.078] },
      { geometry: roundedBox(0.05, doorHeight - 0.3, 0.02), at: [0, doorHeight / 2, 0.078] },
      // The frame.
      { geometry: roundedBox(0.11, doorHeight + 0.1, 0.09), at: [-doorWidth / 2 - 0.075, doorHeight / 2 + 0.05, 0.045] },
      { geometry: roundedBox(0.11, doorHeight + 0.1, 0.09), at: [doorWidth / 2 + 0.075, doorHeight / 2 + 0.05, 0.045] },
      { geometry: roundedBox(doorWidth + 0.34, 0.13, 0.1), at: [0, doorHeight + 0.11, 0.05] },
    ],
    FAR,
  );
  group.add(new Mesh(wood, MATERIALS.wainscot));

  const knob = new Mesh(
    fuse(
      [
        { geometry: new SphereGeometry(0.03, 14, 10), at: [doorWidth / 2 - 0.09, 1.0, 0.105] },
        { geometry: new CylinderGeometry(0.012, 0.016, 0.04, 10), at: [doorWidth / 2 - 0.09, 1.0, 0.08], turn: [Math.PI / 2, 0, 0] },
        { geometry: roundedBox(0.05, 0.16, 0.008), at: [doorWidth / 2 - 0.09, 0.98, 0.076] },
      ],
      FAR,
    ),
    MATERIALS.brass,
  );
  group.add(knob);

  // The gaps: under it, down the latch side, and through the keyhole.
  const glow = MATERIALS.doorLight.clone();
  const gaps = new Mesh(
    fuse(
      [
        { geometry: plane(doorWidth - 0.02, 0.014), at: [0, 0.008, 0.074] },
        { geometry: plane(0.014, doorHeight - 0.02), at: [doorWidth / 2 + 0.012, doorHeight / 2 + 0.01, 0.092] },
        { geometry: plane(doorWidth * 0.6, 0.009), at: [0.12, doorHeight + 0.028, 0.092] },
        { geometry: new CircleGeometry(0.005, 8), at: [doorWidth / 2 - 0.09, 0.93, 0.081] },
      ],
      FAR,
    ),
    glow,
  );
  group.add(gaps);

  // And what it does to the floor on this side.
  const light = new PointLight(0x86a6c8, 0, 4.4, 1.6);
  light.position.set(0.18, 0.1, -ROOM_HALF + 0.3);
  group.add(light);

  return { group, light, glow };
}

/** Four portraits. See `portraitTexture` for what has been done to them. */
function buildPortraits(): { group: Group; canvases: MeshStandardMaterial[] } {
  const group = new Group();
  const canvases: MeshStandardMaterial[] = [];
  const hung: { wall: Matrix4; x: number; y: number; tilt: number }[] = [
    { wall: LEFT, x: -1.25, y: 1.78, tilt: 0 },
    { wall: LEFT, x: 1.2, y: 1.74, tilt: -0.05 },
    { wall: RIGHT, x: -0.2, y: 1.8, tilt: 0.035 },
    { wall: FAR, x: -1.9, y: 1.76, tilt: 0 },
  ];
  const width = 0.5;
  const height = 0.62;
  const moulding = 0.07;

  const frames: BufferGeometry[] = [];
  hung.forEach((picture, sitter) => {
    const hang = new Matrix4().makeRotationZ(picture.tilt).setPosition(picture.x, picture.y, 0.03);
    const place = picture.wall.clone().multiply(hang);

    frames.push(
      fuse(
        [
          { geometry: roundedBox(width + moulding * 2, moulding, 0.045), at: [0, height / 2 + moulding / 2, 0] },
          { geometry: roundedBox(width + moulding * 2, moulding, 0.045), at: [0, -height / 2 - moulding / 2, 0] },
          { geometry: roundedBox(moulding, height, 0.045), at: [-width / 2 - moulding / 2, 0, 0] },
          { geometry: roundedBox(moulding, height, 0.045), at: [width / 2 + moulding / 2, 0, 0] },
        ],
        place,
      ),
    );

    const texture = portraitTexture(sitter);
    const paint = new MeshStandardMaterial({ color: texture ? 0xffffff : 0x1a140f, map: texture, roughness: 0.55 });
    if (texture) {
      // Lent a little of the room's bounce, like the wall it hangs on.
      paint.emissiveMap = texture;
      paint.emissive.set(0xffffff);
      paint.emissiveIntensity = 0;
    }
    canvases.push(paint);
    group.add(new Mesh(fuse([{ geometry: plane(width, height), at: [0, 0, 0.004] }], place), paint));
  });

  group.add(new Mesh(fuse(frames.map((geometry) => ({ geometry }))), MATERIALS.gilt));
  return { group, canvases };
}

/** A sconce: a plate on the wall, an arm, a cup, a candle. The flame is separate. */
function sconceParts(): { brass: Part[]; wax: Part[]; flameAt: [number, number, number] } {
  return {
    brass: [
      { geometry: roundedBox(0.07, 0.2, 0.012), at: [0, 0, 0.006] },
      { geometry: new CylinderGeometry(0.006, 0.006, 0.12, 8), at: [0, -0.03, 0.065], turn: [Math.PI / 2, 0, 0] },
      { geometry: new CylinderGeometry(0.026, 0.014, 0.022, 14), at: [0, -0.018, 0.125] },
    ],
    wax: [{ geometry: new CylinderGeometry(0.011, 0.012, 0.13, 12), at: [0, 0.055, 0.125] }],
    flameAt: [0, 0.137, 0.125],
  };
}

interface Candle {
  light: PointLight;
  flame: Mesh;
  /** The dread at which it starts to gutter, and at which it is out. */
  guttersAt: number;
  outAt: number;
  phase: number;
}

function buildSconces(): { group: Group; candles: Candle[] } {
  const group = new Group();
  const brass: BufferGeometry[] = [];
  const wax: BufferGeometry[] = [];
  const candles: Candle[] = [];

  const hung: { wall: Matrix4; x: number; guttersAt: number; outAt: number }[] = [
    // The first to go is the one furthest from him.
    { wall: LEFT, x: 0.05, guttersAt: 0.22, outAt: 0.36 },
    { wall: RIGHT, x: -1.05, guttersAt: 0.5, outAt: 0.66 },
  ];

  hung.forEach((sconce, index) => {
    const place = sconce.wall.clone().multiply(new Matrix4().makeTranslation(sconce.x, 1.5, 0));
    const parts = sconceParts();
    brass.push(fuse(parts.brass, place));
    wax.push(fuse(parts.wax, place));

    // A flame is taller than it is wide, and comes to a point.
    const flame = new Mesh(new SphereGeometry(0.008, 10, 8), MATERIALS.flame.clone());
    flame.scale.set(1, 2.3, 1);
    flame.position.set(...parts.flameAt).applyMatrix4(place);
    group.add(flame);

    const light = new PointLight(0xff9a4a, 0, 3.8, 1.7);
    // Out from the wall a little, or the wall it hangs on eats it.
    light.position.set(parts.flameAt[0], parts.flameAt[1] + 0.02, parts.flameAt[2] + 0.1).applyMatrix4(place);
    group.add(light);

    candles.push({ light, flame, guttersAt: sconce.guttersAt, outAt: sconce.outAt, phase: index * 17.3 });
  });

  group.add(
    new Mesh(fuse(brass.map((geometry) => ({ geometry }))), MATERIALS.brass),
    new Mesh(fuse(wax.map((geometry) => ({ geometry }))), MATERIALS.wax),
  );
  return { group, candles };
}

/** Heavy drapes across the near wall, drawn. Whatever is behind them stays there. */
function buildDrapes(): Group {
  const group = new Group();
  const width = 3.4;
  const height = 2.5;

  const cloth = new PlaneGeometry(width, height, 96, 6);
  const position = cloth.getAttribute('position') as BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    // Folds: deep regular ones with a slower swell under them, opening out
    // toward the hem where the weight spreads.
    const spread = 0.75 + 0.25 * (0.5 - y / height);
    const fold = Math.sin(x * 21) * 0.05 + Math.sin(x * 7.3 + 1.1) * 0.035 + Math.sin(x * 43) * 0.008;
    position.setZ(i, fold * spread);
  }
  cloth.computeVertexNormals();

  const drapes = new Mesh(fuse([{ geometry: cloth, at: [0, 0.06 + height / 2, 0.14] }], NEAR), MATERIALS.velvet);
  drapes.receiveShadow = true;
  group.add(drapes);

  const pelmet = new Mesh(
    fuse(
      [
        { geometry: roundedBox(width + 0.2, 0.2, 0.22), at: [0, height + 0.14, 0.12] },
        { geometry: new CylinderGeometry(0.014, 0.014, width + 0.3, 8), at: [0, height + 0.03, 0.16], turn: [0, 0, Math.PI / 2] },
      ],
      NEAR,
    ),
    MATERIALS.wainscot,
  );
  group.add(pelmet);
  return group;
}

/** A sideboard against the right wall, with what is left of the drink on it. */
function buildSideboard(): Group {
  const group = new Group();
  const place = RIGHT.clone().multiply(new Matrix4().makeTranslation(-1.55, 0, 0));

  const carcass = new Mesh(
    fuse(
      [
        { geometry: roundedBox(1.3, 0.78, 0.42), at: [0, 0.47, 0.23] },
        { geometry: roundedBox(1.38, 0.035, 0.48), at: [0, 0.877, 0.24] },
        { geometry: roundedBox(0.58, 0.6, 0.012), at: [-0.32, 0.47, 0.444] },
        { geometry: roundedBox(0.58, 0.6, 0.012), at: [0.32, 0.47, 0.444] },
        ...[-0.58, 0.58].flatMap((x): Part[] => [
          { geometry: new CylinderGeometry(0.03, 0.02, 0.08, 10), at: [x, 0.04, 0.08] },
          { geometry: new CylinderGeometry(0.03, 0.02, 0.08, 10), at: [x, 0.04, 0.38] },
        ]),
      ],
      place,
    ),
    MATERIALS.chair,
  );
  carcass.receiveShadow = true;
  group.add(carcass);

  const pulls = new Mesh(
    fuse(
      [
        { geometry: new SphereGeometry(0.014, 10, 8), at: [-0.06, 0.5, 0.456] },
        { geometry: new SphereGeometry(0.014, 10, 8), at: [0.06, 0.5, 0.456] },
      ],
      place,
    ),
    MATERIALS.brass,
  );
  group.add(pulls);

  // Bottles: a body, a shoulder, a neck. Turned, like the table leg.
  const bottle = (height: number, radius: number): BufferGeometry =>
    new LatheGeometry(
      [
        new Vector2(0, 0),
        new Vector2(radius, 0),
        new Vector2(radius, height * 0.58),
        new Vector2(radius * 0.86, height * 0.68),
        new Vector2(radius * 0.36, height * 0.78),
        new Vector2(radius * 0.32, height * 0.97),
        new Vector2(radius * 0.4, height),
      ],
      16,
    );
  const glass = new Mesh(
    fuse(
      [
        { geometry: bottle(0.3, 0.04), at: [-0.44, 0.895, 0.26] },
        { geometry: bottle(0.26, 0.045), at: [-0.31, 0.895, 0.19] },
        { geometry: bottle(0.34, 0.036), at: [-0.2, 0.895, 0.3] },
        { geometry: bottle(0.2, 0.055), at: [0.38, 0.895, 0.22] },
        // One on its side, which nobody has picked up.
        { geometry: bottle(0.28, 0.038), at: [0.12, 0.933, 0.2], turn: [0, 0.5, Math.PI / 2] },
      ],
      place,
    ),
    MATERIALS.bottle,
  );
  group.add(glass);
  return group;
}

// ---------------------------------------------------------------------------

export interface Shell {
  group: Group;
  /**
   * Lets the room's own small lights follow how bad the evening has got.
   *
   * `dread` is the eased value the rest of the lighting already uses, so the
   * candles go out at the pace the lamp turns rather than between two frames.
   */
  update(delta: number, dread: number): void;
  /** Whether the candles and the door actually light anything, or only glow. */
  setLit(lit: boolean): void;
}

/** How bright a candle is while it burns, and the door at each end of the evening. */
const LIGHTS = {
  candle: 2.4,
  door: { calm: 0.9, dread: 2.6 },
  /** Under the bloom threshold at the start, and well over it by the end. */
  doorGlow: { calm: 5, dread: 32 },
  /**
   * How much of their own pattern the walls give back, standing in for the
   * light that comes off the table. Gone entirely by the end of the evening.
   */
  bounce: { calm: 0.34, dread: 0 },
} as const;

/** A flame at full burn. Bright enough to bloom; see `BLOOM` in `post.ts`. */
const FLAME_GLOW = 17;

export function buildShell(): Shell {
  const group = new Group();
  const door = buildDoor();
  const sconces = buildSconces();
  const portraits = buildPortraits();
  group.add(
    buildFloor(),
    buildWalls(),
    door.group,
    portraits.group,
    sconces.group,
    buildDrapes(),
    buildSideboard(),
  );

  let time = 0;
  let lit = true;

  return {
    group,

    setLit(next: boolean): void {
      lit = next;
    },

    update(delta: number, dread: number): void {
      time += delta;

      for (const candle of sconces.candles) {
        // Burning, guttering, out. Once out it stays out: dread only rises.
        const dying = Math.min(Math.max((dread - candle.guttersAt) / (candle.outAt - candle.guttersAt), 0), 1);
        const alive = 1 - dying;
        // A flame never holds still, and a dying one is all over the place.
        const t = time + candle.phase;
        const waver = 0.86 + 0.09 * Math.sin(t * 9.1) + 0.05 * Math.sin(t * 23.7 + 1.3);
        const gutter = dying > 0 ? 0.55 + 0.45 * Math.sin(t * 31 + Math.sin(t * 7.7) * 3) : 1;
        const level = alive * waver * (dying > 0 ? Math.max(gutter, 0.15) : 1);

        // Hidden rather than dimmed when the room is being drawn cheaply: a light
        // at zero is still a light every surface has to ask about.
        candle.light.visible = lit && alive > 0.02;
        candle.light.intensity = LIGHTS.candle * level;
        candle.flame.visible = alive > 0.02;
        candle.flame.scale.set(0.7 + 0.3 * level, 2.3 * (0.55 + 0.45 * level) * waver, 0.7 + 0.3 * level);
        (candle.flame.material as MeshStandardMaterial).emissiveIntensity = FLAME_GLOW * level;
      }

      // The door does the opposite. Slowly enough that nobody sees it happen.
      door.light.visible = lit;
      door.light.intensity = LIGHTS.door.calm + (LIGHTS.door.dread - LIGHTS.door.calm) * dread;
      door.glow.emissiveIntensity =
        LIGHTS.doorGlow.calm + (LIGHTS.doorGlow.dread - LIGHTS.doorGlow.calm) * dread;

      // And the walls go, faster than the lamp does: the room is lost from the
      // outside in.
      const bounce = LIGHTS.bounce.calm * Math.max(0, 1 - dread * 1.5) ** 2;
      for (const wall of BOUNCE_LIT) {
        if (wall.emissiveMap) wall.emissiveIntensity = bounce;
      }
      for (const paint of portraits.canvases) paint.emissiveIntensity = bounce * 1.4;
    },
  };
}
