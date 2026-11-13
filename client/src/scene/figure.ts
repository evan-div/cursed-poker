import {
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COAT_GLARE, MATERIALS } from './materials.js';
import { fuse, type Part } from './shapes.js';
import { weaveBump } from './textures.js';

/**
 * People, as opposed to mannequins.
 *
 * A body here used to be boxes with the corners taken off: a box for a head, a
 * box for a chest, a box for shoulders. That reads its own trembling well and
 * reads as a person not at all, and the whole game is watching people.
 *
 * So the head is sculpted now. It is still built from nothing — a sphere, pushed
 * about by a function — but the function knows where a brow is, and a nose, and
 * the hollows either side of it. That matters more in this room than it would in
 * most, because of where the lamp is: straight overhead, every brow throws its
 * socket into shadow and every face at the table is halfway to a skull. Nobody
 * had to model that. It is just what a face does under that light, the moment
 * it has a brow to do it with.
 *
 * Six people sit at this table and they should not be six of the same person,
 * so each seat has a `Look`: a skin, a head of hair or the lack of one, a coat
 * and what is worn under it. A silhouette across a dark table is most of how
 * anybody knows who they are looking at.
 *
 * The stylisation is deliberate and stays. These are figures, not portraits: no
 * mouths that move, no eyes that follow you. Everything they give away, they
 * give away with their bodies — which is the game.
 */

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------

export type HairStyle = 'crop' | 'bald' | 'swept' | 'bob' | 'cap' | 'bun';

export interface Look {
  skin: string;
  hair: HairStyle;
  hairColour: string;
  coat: string;
  /** What shows in the V of the coat. */
  shirt: string;
  neckwear: 'tie' | 'bow' | 'none' | 'kerchief' | 'pearls';
  neckwearColour: string;
  spectacles?: boolean;
  moustache?: boolean;
}

/** One per seat, in seat order. */
export const LOOKS: readonly Look[] = [
  { skin: '#8a6a55', hair: 'crop', hairColour: '#17120f', coat: '#23211f', shirt: '#8e8676', neckwear: 'tie', neckwearColour: '#4a1210' },
  { skin: '#9a7a66', hair: 'bald', hairColour: '#5a544c', coat: '#3a2e22', shirt: '#857a66', neckwear: 'none', neckwearColour: '#000000', moustache: true },
  { skin: '#6b4a3a', hair: 'bob', hairColour: '#0f0c0b', coat: '#1c1416', shirt: '#2a1a1c', neckwear: 'pearls', neckwearColour: '#b7ab96' },
  { skin: '#a3836c', hair: 'swept', hairColour: '#4a3220', coat: '#1d2a22', shirt: '#8e8676', neckwear: 'bow', neckwearColour: '#161412', spectacles: true },
  { skin: '#7c5a48', hair: 'cap', hairColour: '#2c2a28', coat: '#34322f', shirt: '#6f6a5e', neckwear: 'kerchief', neckwearColour: '#5a1a16' },
  { skin: '#93745f', hair: 'bun', hairColour: '#6e675e', coat: '#15161a', shirt: '#9a9484', neckwear: 'none', neckwearColour: '#000000' },
];

export function lookFor(seatIndex: number): Look {
  return LOOKS[((seatIndex % LOOKS.length) + LOOKS.length) % LOOKS.length]!;
}

const materialCache = new Map<string, MeshStandardMaterial>();

/** A plain material of one colour, shared by everything that colour. */
function tinted(colour: string, roughness: number, metalness = 0): MeshStandardMaterial {
  const key = `${colour}:${roughness}:${metalness}`;
  let material = materialCache.get(key);
  if (!material) {
    material = new MeshStandardMaterial({ color: new Color(colour), roughness, metalness });
    materialCache.set(key, material);
  }
  return material;
}

/**
 * The material clothes are made of.
 *
 * White, and coloured by the cloth itself: a coat, the shirt in its V and the
 * tie down the middle are one mesh with the colours written into its vertices,
 * so a whole outfit is a single draw. Shares its weave with every other coat.
 */
export const GARMENT = new MeshPhysicalMaterial({
  color: 0xffffff,
  roughness: 1,
  vertexColors: true,
  specularIntensity: COAT_GLARE,
});

/**
 * A coat's own colour, for the parts of it that are not the body: sleeves.
 *
 * Woven, where there is a canvas to weave on — a sleeve is the piece of cloth a
 * player sees closest, lying along the bottom of their own view all evening.
 */
export function coatMaterial(look: Look): MeshStandardMaterial {
  const key = `coat:${look.coat}`;
  let material = materialCache.get(key);
  if (!material) {
    material = new MeshPhysicalMaterial({ color: new Color(look.coat), roughness: 1, specularIntensity: COAT_GLARE });
    const weave = weaveBump([5, 5]);
    if (weave) {
      material.bumpMap = weave;
      material.bumpScale = 0.2;
    }
    materialCache.set(key, material);
  }
  return material;
}

// ---------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------

const gauss = (x: number): number => Math.exp(-x * x);
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Half a head, in metres: across, tall, front to back. */
const HEAD = { x: 0.083, y: 0.108, z: 0.097 } as const;

/**
 * Where the surface of a head is, in a given direction from its middle.
 *
 * `dir` is a unit vector: +Y is the crown, +Z is the face. The answer is in the
 * skull's own space, in metres. Everything that sits *on* a head — hair, sweat,
 * spectacles — asks this, so nothing ever floats off it or sinks in.
 *
 * `draped` leaves the jaw out, for hair: hair hangs from the width of the skull
 * rather than following the face in toward the chin.
 */
export function headPoint(dir: Vector3, out: Vector3 = new Vector3(), draped = false): Vector3 {
  const { x, y, z } = dir;
  const below = draped ? 0 : Math.max(-y, 0);
  const above = Math.max(y, 0);

  // A skull is widest above the ears and narrows to a jaw; it is deeper behind
  // than in front.
  const across = HEAD.x * (1 - 0.21 * Math.pow(below, 1.7)) * (1 - 0.04 * above * above);
  const deep = HEAD.z * (z < 0 ? 1.08 : 0.96) * (1 - 0.1 * below * below);

  let px = x * across;
  const py = y * HEAD.y;
  let pz = z * deep;

  if (!draped && z > 0) {
    // The face, faded in from the sides so nothing has an edge.
    const front = smoothstep(0.05, 0.55, z);
    const ax = Math.abs(x);
    let relief = 0;
    // The brow: a ridge, heaviest over each eye.
    relief += 0.0105 * gauss((y - 0.25) / 0.1) * smoothstep(0.9, 0.3, ax);
    // The sockets under it.
    relief -= 0.019 * gauss((ax - 0.4) / 0.19) * gauss((y - 0.07) / 0.115);
    // The nose: a ridge from between the brows, widening and standing further
    // out toward the tip.
    const along = Math.min(Math.max((0.22 - y) / 0.38, 0), 1);
    const bridge = smoothstep(-0.26, -0.15, y) * smoothstep(0.3, 0.16, y);
    relief += (0.005 + 0.021 * along * along) * gauss(x / (0.075 + 0.07 * along)) * bridge;
    // Cheekbones, and the hollow below them.
    relief += 0.0045 * gauss((ax - 0.52) / 0.2) * gauss((y + 0.04) / 0.16);
    relief -= 0.004 * gauss((ax - 0.5) / 0.2) * gauss((y + 0.42) / 0.16);
    // The mouth: two lips and the line between them.
    relief += 0.0045 * gauss(x / 0.26) * gauss((y + 0.415) / 0.075);
    relief -= 0.0038 * gauss(x / 0.24) * gauss((y + 0.415) / 0.02);
    // The chin.
    relief += 0.007 * gauss(x / 0.26) * gauss((y + 0.8) / 0.17);
    pz += relief * front;
    // A jaw has corners.
    px += Math.sign(x) * 0.004 * gauss((y + 0.55) / 0.2) * gauss((ax - 0.75) / 0.25);
  }

  return out.set(px, py, pz);
}

const HEAD_SEGMENTS = { around: 56, up: 40 } as const;

/** A sphere with its seam and poles welded, ready to be pushed into shape. */
function welded(around: number, up: number): BufferGeometry {
  const sphere = new SphereGeometry(1, around, up);
  sphere.deleteAttribute('uv');
  sphere.deleteAttribute('normal');
  return mergeVertices(sphere);
}

let headCache: BufferGeometry | null = null;

/** The head itself, ears included. One geometry for every head at the table. */
export function headGeometry(): BufferGeometry {
  if (headCache) return headCache;

  const skull = welded(HEAD_SEGMENTS.around, HEAD_SEGMENTS.up);
  const position = skull.getAttribute('position') as BufferAttribute;
  const dir = new Vector3();
  const at = new Vector3();
  for (let i = 0; i < position.count; i++) {
    dir.fromBufferAttribute(position, i).normalize();
    headPoint(dir, at);
    position.setXYZ(i, at.x, at.y, at.z);
  }
  skull.computeVertexNormals();

  // Ears: enough to break the outline of the head, and no more.
  const ear = (side: number): Part => ({
    geometry: new SphereGeometry(0.019, 10, 8),
    at: [side * (HEAD.x + 0.002), -0.004, -0.008],
    scale: [0.42, 1, 0.7],
    turn: [0, side * -0.35, 0],
  });

  const parts: Part[] = [{ geometry: skull.toNonIndexed() }, ear(-1), ear(1)];
  // `fuse` keeps UVs, which the skull was stripped of to weld it; give it some.
  for (const part of parts) {
    if (!part.geometry.getAttribute('uv')) {
      const count = part.geometry.getAttribute('position').count;
      part.geometry.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
    }
  }
  headCache = fuse(parts);
  return headCache;
}

/**
 * Where beads of sweat sit: the brow, the temples, and one on its way down.
 *
 * Directions rather than positions, so they are always on the skin wherever the
 * sculpt puts it.
 */
const BEAD_DIRECTIONS: readonly [number, number, number][] = [
  [-0.42, 0.42, 0.8],
  [-0.1, 0.5, 0.86],
  [0.28, 0.4, 0.87],
  [0.5, 0.52, 0.69],
  [-0.86, 0.2, 0.47],
  [0.88, 0.1, 0.46],
  [-0.6, -0.08, 0.79],
];

export function beadGeometry(): BufferGeometry {
  const dir = new Vector3();
  const at = new Vector3();
  return fuse(
    BEAD_DIRECTIONS.map(([x, y, z]): Part => {
      headPoint(dir.set(x, y, z).normalize(), at);
      return {
        geometry: new SphereGeometry(0.0062, 6, 4),
        at: [at.x * 1.01, at.y * 1.01, at.z * 1.01],
        scale: [1, 1.35, 0.7],
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Hair
// ---------------------------------------------------------------------------

interface HairShape {
  /** How far down the forehead it comes, in the middle and at the temples. */
  front: number;
  side: number;
  /** How far down the back of the head it goes. */
  back: number;
  /** How thick it is: how far it stands off the skull. */
  lift: number;
  /** Extra height on top. */
  crown: number;
  /** Bare above this, for a head that has kept only the sides. */
  bareAbove?: number;
  /** Hangs from the skull's width instead of following the jaw. */
  draped?: boolean;
}

const HAIR: Record<HairStyle, HairShape> = {
  crop: { front: 0.56, side: -0.02, back: -0.42, lift: 0.045, crown: 0.01 },
  bald: { front: 1.2, side: -0.08, back: -0.46, lift: 0.03, crown: 0, bareAbove: 0.36 },
  swept: { front: 0.5, side: -0.1, back: -0.58, lift: 0.07, crown: 0.022 },
  bob: { front: 0.5, side: -0.72, back: -0.82, lift: 0.085, crown: 0.012, draped: true },
  cap: { front: 0.62, side: -0.05, back: -0.44, lift: 0.04, crown: 0 },
  bun: { front: 0.5, side: -0.06, back: -0.5, lift: 0.05, crown: 0.008 },
};

/** Whether hair grows in a direction from the middle of the head. */
function hairGrows(shape: HairShape, dir: Vector3): boolean {
  const ax = Math.abs(dir.x);
  const frontLine = shape.front - (shape.front - shape.side) * smoothstep(0.3, 0.92, ax);
  const backLine = shape.side + (shape.back - shape.side) * smoothstep(0, 0.65, -dir.z);
  const line = backLine + (frontLine - backLine) * smoothstep(-0.2, 0.3, dir.z);
  if (dir.y < line) return false;
  if (shape.bareAbove !== undefined && dir.y > shape.bareAbove) return false;
  return true;
}

const hairCache = new Map<HairStyle, BufferGeometry>();

/** A head of hair: a shell over the skull, cut off along the hairline. */
function hairGeometry(style: HairStyle): BufferGeometry {
  const cached = hairCache.get(style);
  if (cached) return cached;

  const shape = HAIR[style];
  const shell = welded(44, 32);
  const position = shell.getAttribute('position') as BufferAttribute;
  const dirs: Vector3[] = [];
  const at = new Vector3();
  for (let i = 0; i < position.count; i++) {
    const dir = new Vector3().fromBufferAttribute(position, i).normalize();
    dirs.push(dir);
    headPoint(dir, at, shape.draped);
    const lift = 1 + shape.lift + shape.crown * Math.max(dir.y, 0);
    position.setXYZ(i, at.x * lift, at.y * lift + shape.crown * Math.max(dir.y, 0), at.z * lift);
  }

  // Keep the triangles that are all hair; the rest is face and neck.
  const index = shell.getIndex()!;
  const kept: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    if (hairGrows(shape, dirs[a]!) && hairGrows(shape, dirs[b]!) && hairGrows(shape, dirs[c]!)) kept.push(a, b, c);
  }
  shell.setIndex(kept);
  shell.computeVertexNormals();

  const geometry = shell.toNonIndexed();
  hairCache.set(style, geometry);
  return geometry;
}

/** Everything a look puts on a head, as one group to hang off the skull. */
export function headDressing(look: Look): Group {
  const group = new Group();
  const hair = tinted(look.hairColour, 0.62);
  const dir = new Vector3();
  const at = new Vector3();
  const on = (x: number, y: number, z: number, out = 1): [number, number, number] => {
    headPoint(dir.set(x, y, z).normalize(), at);
    return [at.x * out, at.y * out, at.z * out];
  };

  const strands = new Mesh(hairGeometry(look.hair), hair);
  strands.castShadow = true;
  group.add(strands);

  if (look.hair === 'bun') {
    const bun = new Mesh(new SphereGeometry(0.036, 14, 10), hair);
    bun.position.set(0, 0.07, -HEAD.z * 1.08 - 0.012);
    bun.castShadow = true;
    group.add(bun);
  }

  if (look.hair === 'cap') {
    // A flat cap: a low crown pulled forward over a short peak.
    const cloth = tinted('#2b2926', 1);
    const cap = new Mesh(
      fuse([
        { geometry: new SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), at: [0, 0.058, 0.004], scale: [0.097, 0.058, 0.118] },
        { geometry: new SphereGeometry(1, 16, 8), at: [0, 0.058, 0.105], scale: [0.07, 0.008, 0.045] },
      ]),
      cloth,
    );
    cap.castShadow = true;
    group.add(cap);
  }

  if (look.moustache) {
    const whiskers = new Mesh(
      fuse(
        [-1, 1].map((side): Part => {
          const [x, y, z] = on(side * 0.17, -0.3, 0.94, 1.02);
          return {
            geometry: new CapsuleGeometry(0.0052, 0.02, 3, 8),
            at: [x, y, z],
            turn: [0, 0, side * 1.25],
          };
        }),
      ),
      hair,
    );
    group.add(whiskers);
  }

  if (look.spectacles) {
    // Round wire frames. Mostly they are two glints the lamp finds.
    const wire = tinted('#8a6a2c', 0.3, 0.9);
    const lens = (side: number): Part => {
      const [x, y, z] = on(side * 0.4, 0.08, 0.92, 1);
      return { geometry: new TorusGeometry(0.0185, 0.0013, 5, 20), at: [x, y, z + 0.019], turn: [0, side * 0.12, 0] };
    };
    const [, bridgeY, bridgeZ] = on(0, 0.1, 1, 1);
    const frames = new Mesh(
      fuse([
        lens(-1),
        lens(1),
        { geometry: new CapsuleGeometry(0.0012, 0.02, 2, 6), at: [0, bridgeY, bridgeZ + 0.007], turn: [0, 0, Math.PI / 2] },
        ...[-1, 1].map(
          (side): Part => ({
            geometry: new CapsuleGeometry(0.0011, 0.085, 2, 6),
            at: [side * (HEAD.x + 0.001), bridgeY, 0.03],
            turn: [Math.PI / 2, 0, 0],
          }),
        ),
      ]),
      wire,
    );
    group.add(frames);
  }

  // Eyes: set back in their sockets, dark and wet. Under this lamp they are two
  // shadows with, now and then, a point of light in each.
  const eyes = new Mesh(
    fuse(
      [-1, 1].map((side): Part => {
        const [x, y, z] = on(side * 0.4, 0.07, 0.92, 1);
        return { geometry: new SphereGeometry(0.0115, 10, 8), at: [x, y, z - 0.0075] };
      }),
    ),
    MATERIALS.eyeball,
  );
  group.add(eyes);

  return group;
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

/** A sphere pushed into a rounded slab: a chest, a pair of shoulders. */
function slab(
  around: number,
  up: number,
  shape: (angle: number, t: number, out: Vector3) => void,
): { geometry: BufferGeometry; rings: { angle: number; t: number }[] } {
  const geometry = welded(around, up);
  const position = geometry.getAttribute('position') as BufferAttribute;
  const rings: { angle: number; t: number }[] = [];
  const at = new Vector3();
  for (let i = 0; i < position.count; i++) {
    at.fromBufferAttribute(position, i);
    const t = Math.min(Math.max(at.y, -1), 1);
    // Measured from the front (+Z), positive toward +X.
    const angle = Math.atan2(at.x, at.z);
    rings.push({ angle, t });
    shape(angle, t, at);
    position.setXYZ(i, at.x, at.y, at.z);
  }
  geometry.computeVertexNormals();
  return { geometry, rings };
}

/** A squared-off circle: `power` above one flattens the sides. */
const squared = (value: number, power: number): number => Math.sign(value) * Math.pow(Math.abs(value), 1 / power);

/** Half a torso's height, in metres. The rest of its shape follows from this. */
const TORSO_HALF_HEIGHT = 0.232;

/**
 * A torso, dressed.
 *
 * Wider at the chest than the waist, flatter behind than in front, and coloured
 * by vertex: the coat, the shirt in its V, lapels a shade off the coat, and
 * whatever is worn at the throat.
 */
export function torsoGeometry(look: Look): BufferGeometry {
  const coat = new Color(look.coat);
  const lapel = coat.clone().multiplyScalar(1.45);
  const shirt = new Color(look.shirt);
  const neck = new Color(look.neckwearColour);

  const { geometry, rings } = slab(64, 40, (angle, t, out) => {
    // Fat until close to the ends, so it is a trunk and not an egg.
    const ring = Math.pow(Math.max(1 - t * t, 0), 0.22);
    const chest = gauss((t - 0.35) / 0.55);
    const halfWidth = (0.158 + 0.036 * chest) * ring;
    const halfDepth = (0.098 + 0.024 * chest) * ring * (Math.cos(angle) > 0 ? 1.06 : 0.9);
    out.set(
      squared(Math.sin(angle), 1.5) * halfWidth,
      squared(t, 1.25) * TORSO_HALF_HEIGHT,
      squared(Math.cos(angle), 1.5) * halfDepth,
    );
  });

  const position = geometry.getAttribute('position') as BufferAttribute;
  const colours = new Float32Array(position.count * 3);
  const paint = new Color();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const front = rings[i]!.angle;
    paint.copy(coat);

    if (Math.abs(front) < Math.PI / 2 && position.getZ(i) > 0) {
      // The V: open at the collar, closed a hand's width down the chest.
      const depth = TORSO_HALF_HEIGHT - y;
      const open = look.neckwear === 'pearls' ? 0.16 : 0.21;
      const halfV = Math.max(0, 0.078 * (1 - depth / open));
      const ax = Math.abs(x);
      if (depth < open && ax < halfV) {
        paint.copy(shirt);
        if (look.neckwear === 'tie' && ax < 0.013 + 0.006 * (depth / open)) paint.copy(neck);
        if (look.neckwear === 'bow' && depth < 0.045 && ax < 0.034) paint.copy(neck);
        if (look.neckwear === 'kerchief' && depth < 0.09) paint.copy(neck);
      } else if (depth < open + 0.03 && ax < halfV + 0.03) {
        paint.copy(lapel);
      } else if (ax < 0.006 && depth > open + 0.04 && Math.floor(depth / 0.07) !== Math.floor((depth - 0.012) / 0.07)) {
        // Buttons, down the front.
        paint.copy(lapel);
      }
    }
    colours[i * 3] = paint.r;
    colours[i * 3 + 1] = paint.g;
    colours[i * 3 + 2] = paint.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colours, 3));
  return geometry;
}

/**
 * Shoulders: a yoke that slopes away from the neck.
 *
 * Without them the head floats — a lit face over a dark torso with a thin neck
 * between reads as a severed one, which is the right effect for entirely the
 * wrong reason.
 */
export function shoulderGeometry(look: Look): BufferGeometry {
  const coat = new Color(look.coat);
  const { geometry } = slab(40, 20, (angle, t, out) => {
    const ring = Math.pow(Math.max(1 - t * t, 0), 0.34);
    const x = squared(Math.sin(angle), 1.35) * 0.218 * ring;
    out.set(
      x,
      // Highest at the neck, falling toward each arm.
      t * 0.062 - 0.055 * Math.pow(Math.abs(x) / 0.218, 1.7),
      squared(Math.cos(angle), 1.35) * 0.118 * ring,
    );
  });
  const count = geometry.getAttribute('position').count;
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colours[i * 3] = coat.r;
    colours[i * 3 + 1] = coat.g;
    colours[i * 3 + 2] = coat.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colours, 3));
  return geometry;
}

/**
 * What is worn at the neck: a collar, and for one look a string of pearls.
 *
 * Returned as a mesh to hang off the shoulders, so it rides up with them on
 * each breath.
 */
export function collar(look: Look): Mesh {
  const parts: Part[] = [
    // A soft band round the base of the neck, open at the front.
    {
      geometry: new TorusGeometry(0.056, 0.012, 6, 18, Math.PI * 1.7),
      at: [0, 0, 0],
      turn: [Math.PI / 2 - 0.16, 0, Math.PI / 2 + Math.PI * 0.15],
      scale: [1, 1.1, 1.5],
    },
  ];
  if (look.neckwear === 'pearls') {
    for (let pearl = 0; pearl < 15; pearl++) {
      const angle = ((pearl - 7) / 7) * 1.25;
      parts.push({
        geometry: new SphereGeometry(0.0062, 7, 5),
        at: [Math.sin(angle) * 0.066, -0.026 - 0.03 * Math.cos(angle), 0.03 + 0.075 * Math.cos(angle)],
      });
    }
  }
  const mesh = new Mesh(fuse(parts), look.neckwear === 'pearls' ? tinted(look.neckwearColour, 0.3) : tinted(look.shirt, 0.92));
  mesh.castShadow = true;
  return mesh;
}

/** A cuff: the pale ring between a sleeve and a wrist. */
export function cuffMaterial(look: Look): MeshStandardMaterial {
  return tinted(look.shirt, 0.92);
}
