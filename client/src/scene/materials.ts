import { Color, DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial, type Material } from 'three';
import {
  feltSurface,
  floorSurface,
  leatherSurface,
  plasterSurface,
  rugSurface,
  wallpaperSurface,
  weaveBump,
  woodSurface,
  type Surface,
} from './textures.js';

/**
 * Shared materials.
 *
 * Every mesh in the scene draws from this palette rather than making its own,
 * so the renderer switches material state a handful of times per frame instead
 * of once per object. Six seated players is a lot of small meshes; sharing is
 * the cheapest thing that keeps that affordable.
 *
 * The palette is four things and their shadows: green baize, oxblood leather,
 * dark walnut and tarnished brass. Everything else in the room is one of those
 * with less light on it.
 *
 * Materials are made here as plain colours, and stay that way under a test.
 * `dressMaterials` paints their surfaces on — see `textures.ts` — and is called
 * once, by the scene, in a browser.
 */

const materials: Material[] = [];

interface StandardOptions {
  color: string;
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
}

function standard(options: StandardOptions): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: new Color(options.color),
    roughness: options.roughness ?? 0.9,
    metalness: options.metalness ?? 0,
  });
  if (options.emissive) {
    material.emissive = new Color(options.emissive);
    material.emissiveIntensity = options.emissiveIntensity ?? 1;
  }
  materials.push(material);
  return material;
}

/**
 * Cloth with a nap: baize, velvet.
 *
 * Sheen is the faint pale bloom a fabric shows at a glancing angle, and a
 * glancing angle is the only one anybody at this table ever sees the felt from.
 * Without it baize reads as painted board.
 */
function napped(options: StandardOptions & { sheen: string; sheenRoughness?: number }): MeshPhysicalMaterial {
  const material = new MeshPhysicalMaterial({
    color: new Color(options.color),
    roughness: options.roughness ?? 1,
    metalness: 0,
    sheen: 1,
    sheenColor: new Color(options.sheen),
    sheenRoughness: options.sheenRoughness ?? 0.55,
  });
  materials.push(material);
  return material;
}

/**
 * Dark cloth.
 *
 * The lamp is strong enough that the few percent of light every surface throws
 * back as glare is, on a black coat, most of what the coat throws back at all:
 * a robe the colour of soot came out the colour of sand. Turning that glare
 * down is what lets a dark thing under this lamp stay dark.
 */
function cloth(color: string, glare: number): MeshPhysicalMaterial {
  const material = new MeshPhysicalMaterial({
    color: new Color(color),
    roughness: 1,
    metalness: 0,
    specularIntensity: glare,
  });
  materials.push(material);
  return material;
}

/** How much of the usual glare a coat keeps. See `cloth`. */
export const COAT_GLARE = 0.4;

export const MATERIALS = {
  felt: napped({ color: '#14362a', roughness: 1, sheen: '#5d8f6a', sheenRoughness: 0.5 }),
  rail: standard({ color: '#3a1010', roughness: 0.5 }),
  wood: standard({ color: '#2a170f', roughness: 0.62 }),
  floor: standard({ color: '#1a100b', roughness: 0.82 }),
  chair: standard({ color: '#21130d', roughness: 0.6 }),
  /** Seat cushions: the same hide as the rail, older. */
  chairLeather: standard({ color: '#1c1211', roughness: 0.58 }),

  /**
   * Skin, carrying a trace of its own light.
   *
   * The one lamp is above the middle of the table, so a hand held up in front of
   * its owner is turned away from it and reads as a black slab — and the hands
   * are up exactly when there is something worth watching them do. Faint enough
   * that it never looks lit, only present.
   */
  skin: standard({
    color: '#7d6250',
    roughness: 0.88,
    emissive: '#7d6250',
    emissiveIntensity: 0.09,
  }),
  /**
   * A bead of sweat. Nearly mirror-smooth, so it catches the one lamp from
   * across the table — which is the only reason anybody would see it.
   */
  sweat: standard({
    color: '#b9a99a',
    roughness: 0.14,
    emissive: '#d8c6b4',
    emissiveIntensity: 0.18,
  }),
  /** Wet and dark, and deep enough in its socket that it is mostly a glint. */
  eyeball: standard({ color: '#0d0a09', roughness: 0.28 }),

  robe: cloth('#100d0e', 0.1),
  hoodVoid: standard({ color: '#000000', roughness: 1 }),
  eye: standard({ color: '#2a0705', emissive: '#d82814', emissiveIntensity: 6 }),
  /** What his hands are made of. Not the robe; not skin either. */
  bone: standard({ color: '#8d8672', roughness: 0.55, emissive: '#3a362c', emissiveIntensity: 0.25 }),

  brass: standard({ color: '#7a5c26', roughness: 0.38, metalness: 0.85 }),
  /**
   * The lamp shade: green glass, lit from inside.
   *
   * It was dark enamel first, and from across the room it was a hole — a lamp
   * with nothing round it but the bright edge of its own lining. Glass that
   * takes a little of the bulb and gives it back green is the shade every card
   * room has, and it is the only green in here that is not the felt.
   */
  enamel: standard({ color: '#0c2a1c', roughness: 0.25, emissive: '#1d7a4c', emissiveIntensity: 1.1 }),
  /** The inside of it, which is where the light comes from as far as an eye can tell. */
  lampGlow: standard({ color: '#f1e3c6', emissive: '#ffc98a', emissiveIntensity: 5 }),
  /** The bulb itself. Bright enough to bloom; nobody looks at it for long. */
  filament: standard({ color: '#fff4dc', emissive: '#ffd9a0', emissiveIntensity: 80 }),

  wallpaper: standard({ color: '#3a1717', roughness: 0.95 }),
  wainscot: standard({ color: '#1d100b', roughness: 0.55 }),
  plaster: standard({ color: '#3f372f', roughness: 1 }),
  rug: standard({ color: '#3a1a18', roughness: 1 }),
  gilt: standard({ color: '#6e5424', roughness: 0.5, metalness: 0.7 }),
  velvet: napped({ color: '#2a0a0d', roughness: 1, sheen: '#8a3a3a', sheenRoughness: 0.4 }),
  wax: standard({ color: '#b9ab8c', roughness: 0.6, emissive: '#6a4a22', emissiveIntensity: 0.5 }),
  flame: standard({ color: '#fff1c4', emissive: '#ffb04a', emissiveIntensity: 17 }),
  /** What comes round the edges of the door behind him. Cold, and not daylight. */
  doorLight: standard({ color: '#0a1016', emissive: '#7d9ab8', emissiveIntensity: 12 }),
  /** Glass that has stopped being transparent. */
  bottle: standard({ color: '#0c1a12', roughness: 0.15, metalness: 0.2 }),
} as const;

/**
 * Chip colours by denomination, cheapest first: bone, oxblood, slate, violet,
 * and black for the ones that end an evening.
 */
export const CHIP_COLOURS = ['#b8ad98', '#8a1f1b', '#2f5578', '#4a2f6e', '#17140f'] as const;

/** The spots on a chip's edge, to match: cream, except on the black. */
export const CHIP_TRIM_COLOURS = ['#6e2a22', '#d9cfb8', '#d9cfb8', '#d9cfb8', '#b08a3c'] as const;

/** The surfaces the lamp reaches only by reflection. See `lend`, below. */
export const BOUNCE_LIT = [MATERIALS.wallpaper, MATERIALS.wainscot, MATERIALS.plaster, MATERIALS.floor] as const;

let dressing: Promise<void> | null = null;

/** Lets the page breathe between one surface and the next. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Paints the palette's surfaces on.
 *
 * Separate from building the materials because painting needs a canvas, and the
 * scene's logic has to run where there is none: without a DOM every painter
 * returns nothing and the materials stay plain colours.
 *
 * It also takes a moment — a megapixel of felt is a megapixel of arithmetic —
 * so it is done one surface at a time with a gap between them, and it is
 * started as soon as the page loads rather than when the table appears.
 * Somebody sitting in the lobby waiting for a fourth player is waiting anyway;
 * by the time the host begins, the room is already painted. Call it as often as
 * you like: there is only ever one run.
 */
export function dressMaterials(): Promise<void> {
  dressing ??= dress();
  return dressing;
}

async function dress(): Promise<void> {
  const apply = (
    material: MeshStandardMaterial,
    surface: Surface | null,
    options: { bumpScale?: number; tint?: string } = {},
  ): void => {
    if (!surface) return;
    material.map = surface.map;
    // The painted surface carries the colour now; the material only tints it.
    material.color.set(options.tint ?? '#ffffff');
    if (surface.bump) {
      material.bumpMap = surface.bump;
      material.bumpScale = options.bumpScale ?? 1;
    }
    material.needsUpdate = true;
  };

  /**
   * Lets a wall be found in the dark.
   *
   * A lamp over a green table in a small room lights the room, faintly, by
   * what comes back off the table — and nothing here computes that. Giving the
   * walls a trace of their own pattern as glow stands in for it at no cost to
   * anything: no light, no shadow, one multiply. `room-shell.ts` turns it down
   * as the evening goes, which is how the walls leave.
   */
  const lend = (material: MeshStandardMaterial): void => {
    if (!material.map) return;
    material.emissiveMap = material.map;
    material.emissive.set('#ffffff');
    material.emissiveIntensity = 0;
    material.needsUpdate = true;
  };

  // In the order a player will notice them missing.
  const jobs: (() => void)[] = [
    () => apply(MATERIALS.felt, feltSurface(), { bumpScale: 0.5 }),
    // Once round the tube and seven times round the table, which keeps a pore
    // the same size in both directions.
    () => apply(MATERIALS.rail, leatherSurface('oxblood', true, [7, 1]), { bumpScale: 0.45 }),
    () => {
      apply(MATERIALS.wood, woodSurface([3, 1]), { bumpScale: 0.25 });
      apply(MATERIALS.chair, woodSurface([1, 2]), { bumpScale: 0.25, tint: '#d2bfb2' });
      apply(MATERIALS.wainscot, woodSurface([2, 2]), { bumpScale: 0.3, tint: '#f0e2d6' });
    },
    () => apply(MATERIALS.chairLeather, leatherSurface('black', false, [2, 4]), { bumpScale: 0.35 }),
    () => {
      // Coats get their weave where they are made: see `coatMaterial`.
      const coarse = weaveBump([10, 16], true);
      if (coarse) {
        MATERIALS.robe.bumpMap = coarse;
        MATERIALS.robe.bumpScale = 0.9;
        MATERIALS.robe.needsUpdate = true;
      }
    },
    () => apply(MATERIALS.floor, floorSurface([9, 9]), { bumpScale: 0.8 }),
    () => {
      const rug = rugSurface();
      if (!rug) return;
      MATERIALS.rug.map = rug.map;
      MATERIALS.rug.color.set('#ffffff');
      // The fringe is painted with holes in it.
      MATERIALS.rug.alphaTest = 0.5;
      MATERIALS.rug.needsUpdate = true;
    },
    () => {
      apply(MATERIALS.wallpaper, wallpaperSurface([11, 3]));
      apply(MATERIALS.plaster, plasterSurface([3, 3]));
      for (const wall of BOUNCE_LIT) lend(wall);
    },
  ];

  for (const job of jobs) {
    job();
    await breathe();
  }
}

// A shade is seen from underneath, a hood from in front, a drape from wherever.
MATERIALS.enamel.side = DoubleSide;
MATERIALS.robe.side = DoubleSide;
MATERIALS.velvet.side = DoubleSide;

export function disposeMaterials(): void {
  for (const material of materials) material.dispose();
  materials.length = 0;
}
