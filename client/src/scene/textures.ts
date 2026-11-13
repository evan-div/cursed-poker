import { CanvasTexture, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';
import { CARD, POT_POSITION, RADIUS, STATION_COUNT, TABLE, boardCardPosition, stationAngle } from './layout.js';
import { fbm, seeded, valueNoise } from './noise.js';

/**
 * Everything in the room that has a surface.
 *
 * The scene is still built from nothing: no models, no image files, nothing to
 * fetch. What changed is that "from nothing" stopped meaning "flat colour". A
 * table is not a green disc; it is baize with a nap, worn pale where forty years
 * of forearms have rested on it, with a line printed on it that somebody chose.
 * All of that is painted here, once, at start-up, into canvases — the same trade
 * the card atlas and the audio already make.
 *
 * Three rules:
 *
 * - **Seeded, always.** See `noise.ts`. Six players must be looking at the same
 *   stain.
 * - **Lazy and cached.** Nothing is painted until something asks for it, and
 *   nothing is painted twice.
 * - **Optional.** With no DOM there is no canvas, so every function here may
 *   return `null` and every caller has to be content with a plain colour. That
 *   is what lets the scene's logic run under a test, where nobody is looking.
 */

type Rgb = [number, number, number];

const HAS_DOM = typeof document !== 'undefined';

function makeCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (!HAS_DOM) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D context to paint a texture');
  return ctx;
}

interface TextureOptions {
  /** Colour data (true) or plain numbers such as a height map (false). */
  colour?: boolean;
  repeat?: [number, number];
  anisotropy?: number;
}

function toTexture(canvas: HTMLCanvasElement, options: TextureOptions = {}): Texture {
  const texture = new CanvasTexture(canvas);
  if (options.colour ?? true) texture.colorSpace = SRGBColorSpace;
  if (options.repeat) {
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(options.repeat[0], options.repeat[1]);
  }
  // Nearly everything in this room is seen at a glancing angle from a chair.
  texture.anisotropy = options.anisotropy ?? 8;
  return texture;
}

/** Fills a canvas one pixel at a time. `shade` writes 0..255 into `out`. */
function fill(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  shade: (x: number, y: number, out: Rgb) => void,
): void {
  const image = ctx.createImageData(width, height);
  const out: Rgb = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      shade(x, y, out);
      const i = (y * width + x) * 4;
      image.data[i] = out[0];
      image.data[i + 1] = out[1];
      image.data[i + 2] = out[2];
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

const mixTo = (out: Rgb, a: Rgb, b: Rgb, t: number, scale = 1): void => {
  out[0] = (a[0] + (b[0] - a[0]) * t) * scale;
  out[1] = (a[1] + (b[1] - a[1]) * t) * scale;
  out[2] = (a[2] + (b[2] - a[2]) * t) * scale;
};

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * A slow-varying quantity, worked out on a coarse grid and interpolated.
 *
 * Most of what makes a surface look old changes over centimetres: where it has
 * worn, where it has stained, how the grain wanders. Asking four octaves of
 * noise for an answer at every pixel was most of a five-second pause when the
 * table first appeared; asking at every eighth pixel and blending in between
 * gives the same picture for a sixty-fourth of the work. Fine detail — fibre,
 * pores — is still decided per pixel, by `grain`, which is one hash.
 */
function coarse(
  width: number,
  height: number,
  cell: number,
  sample: (u: number, v: number) => number,
): (x: number, y: number) => number {
  const columns = Math.ceil(width / cell) + 1;
  const rows = Math.ceil(height / cell) + 1;
  const data = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      data[row * columns + column] = sample((column * cell) / width, (row * cell) / height);
    }
  }
  return (x, y) => {
    const fx = x / cell;
    const fy = y / cell;
    const column = fx | 0;
    const row = fy | 0;
    const tx = fx - column;
    const ty = fy - row;
    const i = row * columns + column;
    const a = data[i]!;
    const b = data[i + 1]!;
    const c = data[i + columns]!;
    const d = data[i + columns + 1]!;
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

/** One value in [0, 1) per pixel, unrelated to its neighbours: grain. */
function grain(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4_294_967_296;
}

const cache = new Map<string, unknown>();

function once<T>(key: string, make: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  const made = make();
  cache.set(key, made);
  return made;
}

export interface Surface {
  map: Texture;
  /** Height, for the light to catch. Not every surface has one worth having. */
  bump?: Texture;
}

// ---------------------------------------------------------------------------
// The felt
// ---------------------------------------------------------------------------

const FELT_SIZE = 1024;
const FELT_BASE: Rgb = [11, 34, 25];
const FELT_WORN: Rgb = [34, 52, 37];
const GILT = '190, 160, 96';

/** Canvas pixels per metre, and the canvas point for a spot on the table. */
const FELT_SCALE = FELT_SIZE / (TABLE.feltRadius * 2);
const onFelt = (x: number, z: number): [number, number] => [
  (x / TABLE.feltRadius + 1) * 0.5 * FELT_SIZE,
  (z / TABLE.feltRadius + 1) * 0.5 * FELT_SIZE,
];

/**
 * The playing surface.
 *
 * Painted in table coordinates: the canvas is the felt seen from the lamp, with
 * the Dealer at the top, so anything drawn here lands exactly where `layout.ts`
 * says it is. The felt mesh is built to match — see `buildFelt` in `table.ts`.
 *
 * What is printed on it is a heptagram. Seven stations, six players and the
 * thing at the head of the table, joined by one unbroken line: the layout was
 * always a seven-pointed figure, and this is the room admitting it.
 */
export function feltSurface(): Surface | null {
  return once('felt', () => {
    const canvas = makeCanvas(FELT_SIZE, FELT_SIZE);
    const bumpCanvas = makeCanvas(FELT_SIZE, FELT_SIZE);
    if (!canvas || !bumpCanvas) return null;
    const ctx = context(canvas);

    const seatAngles = Array.from({ length: STATION_COUNT - 1 }, (_, seat) => stationAngle(seat + 1));
    const heights = new Float32Array(FELT_SIZE * FELT_SIZE);

    const mottle = coarse(FELT_SIZE, FELT_SIZE, 8, (u, v) => fbm(u * 5, v * 5, 4, 11));
    // Worn where cards are dealt and gathered, and where arms have rested.
    const wearAt = coarse(FELT_SIZE, FELT_SIZE, 8, (u, v) => {
      const wx = (2 * u - 1) * TABLE.feltRadius;
      const wz = (2 * v - 1) * TABLE.feltRadius;
      const r = Math.hypot(wx, wz);
      let wear = smoothstep(0.3, 0.02, r) * 0.3;
      if (r > 0.4) {
        // Clockwise from the far side, the way `stationAngle` measures.
        const angle = Math.atan2(wx, -wz);
        let nearest = Math.PI;
        for (const seat of seatAngles) {
          const d = Math.abs(Math.atan2(Math.sin(angle - seat), Math.cos(angle - seat)));
          if (d < nearest) nearest = d;
        }
        wear += Math.exp(-((nearest / 0.26) ** 2)) * smoothstep(0.42, 0.57, r) * 0.55;
      }
      return wear;
    });

    fill(ctx, FELT_SIZE, FELT_SIZE, (x, y, out) => {
      const m = mottle(x, y);
      const fibre = grain(x, y, 5) * 0.6 + grain(x >> 1, y >> 1, 7) * 0.4;
      // The nap lies one way, in streaks.
      const nap = valueNoise(x * 0.045, y * 0.0127, 23);
      const wear = Math.min(wearAt(x, y) * (0.45 + 0.75 * m), 1);

      const shade = 0.8 + 0.26 * m + 0.17 * (fibre - 0.5) + 0.1 * (nap - 0.5);
      mixTo(out, FELT_BASE, FELT_WORN, wear, shade);
      heights[y * FELT_SIZE + x] = fibre * 0.7 + nap * 0.3 - wear * 0.25;
    });

    paintFeltMarkings(ctx);
    paintFeltStains(ctx);

    fill(context(bumpCanvas), FELT_SIZE, FELT_SIZE, (x, y, out) => {
      const h = Math.min(Math.max(heights[y * FELT_SIZE + x]!, 0), 1) * 255;
      out[0] = out[1] = out[2] = h;
    });

    return { map: toTexture(canvas, { anisotropy: 16 }), bump: toTexture(bumpCanvas, { colour: false }) };
  });
}

/** Gilt lines, printed once and worn since. */
function paintFeltMarkings(ctx: CanvasRenderingContext2D): void {
  const overlay = makeCanvas(FELT_SIZE, FELT_SIZE)!;
  const ink = context(overlay);
  const centre = FELT_SIZE / 2;
  const metres = (m: number) => m * FELT_SCALE;

  ink.strokeStyle = `rgba(${GILT}, 1)`;
  ink.fillStyle = `rgba(${GILT}, 1)`;
  ink.lineCap = 'round';
  ink.lineJoin = 'round';

  // The outer rule: two lines just inside the rail.
  for (const [radius, width] of [
    [0.632, 2.2],
    [0.618, 1],
  ] as const) {
    ink.lineWidth = width;
    ink.beginPath();
    ink.arc(centre, centre, metres(radius), 0, Math.PI * 2);
    ink.stroke();
  }

  // The betting line: chips pushed past it are bet.
  const line = (RADIUS.chips + RADIUS.bet) / 2 + 0.01;
  ink.lineWidth = 1.6;
  ink.beginPath();
  ink.arc(centre, centre, metres(line), 0, Math.PI * 2);
  ink.stroke();

  // The heptagram: every station joined to the one three places round.
  ink.lineWidth = 1.2;
  ink.beginPath();
  for (let step = 0; step <= STATION_COUNT; step++) {
    const angle = stationAngle((step * 3) % STATION_COUNT);
    const [x, y] = onFelt(Math.sin(angle) * line, -Math.cos(angle) * line);
    if (step === 0) ink.moveTo(x, y);
    else ink.lineTo(x, y);
  }
  ink.stroke();

  // A mark where each point of it touches the line, and a larger one for him.
  for (let station = 0; station < STATION_COUNT; station++) {
    const angle = stationAngle(station);
    const [x, y] = onFelt(Math.sin(angle) * line, -Math.cos(angle) * line);
    ink.save();
    ink.translate(x, y);
    ink.rotate(angle);
    const size = station === 0 ? 9 : 5.5;
    ink.beginPath();
    ink.moveTo(0, -size);
    ink.lineTo(size * 0.62, 0);
    ink.lineTo(0, size);
    ink.lineTo(-size * 0.62, 0);
    ink.closePath();
    ink.fill();
    ink.restore();
  }

  // Where the board is laid, and where the pot is gathered.
  ink.lineWidth = 1;
  for (let index = 0; index < 5; index++) {
    const at = boardCardPosition(index);
    const [x, y] = onFelt(at.x, at.z);
    const w = metres(CARD.width) + 5;
    const h = metres(CARD.height) + 5;
    ink.beginPath();
    ink.roundRect(x - w / 2, y - h / 2, w, h, 7);
    ink.stroke();
  }
  const [potX, potY] = onFelt(POT_POSITION.x, POT_POSITION.z);
  ink.beginPath();
  ink.arc(potX, potY, metres(0.062), 0, Math.PI * 2);
  ink.stroke();
  ink.setLineDash([2, 5]);
  ink.beginPath();
  ink.arc(potX, potY, metres(0.071), 0, Math.PI * 2);
  ink.stroke();
  ink.setLineDash([]);

  // The legend, set round the table so each arc reads from the chair behind it.
  const legend = 'MEMENTO MORI  ·  ALEA IACTA EST  ·  ';
  const text = legend.repeat(4);
  const textRadius = metres(0.598);
  ink.font = '600 14px Georgia, "Times New Roman", serif';
  ink.textAlign = 'center';
  ink.textBaseline = 'middle';
  for (let i = 0; i < text.length; i++) {
    const angle = (i / text.length) * Math.PI * 2;
    ink.save();
    ink.translate(centre + Math.sin(angle) * textRadius, centre - Math.cos(angle) * textRadius);
    // Tops of the letters toward the middle, so the near arc is the right way up.
    ink.rotate(angle + Math.PI);
    ink.fillText(text[i]!, 0, 0);
    ink.restore();
  }

  // Printed a long time ago. Rubbed thin by the same hands that wore the nap.
  const rub = coarse(FELT_SIZE, FELT_SIZE, 8, (u, v) => fbm(u * 11, v * 11, 3, 61));
  const image = ink.getImageData(0, 0, FELT_SIZE, FELT_SIZE);
  for (let y = 0; y < FELT_SIZE; y++) {
    for (let x = 0; x < FELT_SIZE; x++) {
      const i = (y * FELT_SIZE + x) * 4 + 3;
      if (image.data[i] === 0) continue;
      image.data[i] = image.data[i]! * Math.min(1, 0.18 + 0.9 * rub(x, y)) * (0.55 + 0.45 * grain(x, y, 67)) * 0.42;
    }
  }
  ink.putImageData(image, 0, 0);
  ctx.drawImage(overlay, 0, 0);
}

/** What has been spilled here. Nobody says what the dark one is. */
function paintFeltStains(ctx: CanvasRenderingContext2D): void {
  const random = seeded(1907);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';

  const blot = (x: number, z: number, radius: number, colour: Rgb, lobes: number): void => {
    const [cx, cy] = onFelt(x, z);
    for (let lobe = 0; lobe < lobes; lobe++) {
      const angle = random() * Math.PI * 2;
      const reach = radius * FELT_SCALE * random() * 0.6;
      const size = radius * FELT_SCALE * (0.45 + random() * 0.6);
      const px = cx + Math.cos(angle) * reach;
      const py = cy + Math.sin(angle) * reach;
      const gradient = ctx.createRadialGradient(px, py, 0, px, py, size);
      gradient.addColorStop(0, `rgb(${colour[0]}, ${colour[1]}, ${colour[2]})`);
      gradient.addColorStop(0.7, `rgb(${(colour[0] + 255) >> 1}, ${(colour[1] + 255) >> 1}, ${(colour[2] + 255) >> 1})`);
      gradient.addColorStop(1, 'rgb(255, 255, 255)');
      ctx.fillStyle = gradient;
      ctx.fillRect(px - size, py - size, size * 2, size * 2);
    }
  };

  blot(-0.3, -0.33, 0.085, [150, 96, 84], 7);
  blot(0.38, 0.12, 0.05, [170, 160, 138], 5);
  blot(-0.12, 0.36, 0.04, [176, 170, 150], 4);

  // The ring a glass leaves.
  const [gx, gy] = onFelt(0.44, -0.2);
  ctx.strokeStyle = 'rgb(176, 168, 150)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(gx, gy, 0.034 * FELT_SCALE, 0.4, Math.PI * 1.9);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Leather
// ---------------------------------------------------------------------------

/**
 * The padded rail, and anything else upholstered.
 *
 * `stitched` adds two seams along the length of it, placed for a torus whose
 * texture runs once round the tube: one on top toward the outside, one on top
 * toward the felt.
 */
export function leatherSurface(tone: 'oxblood' | 'black', stitched: boolean, repeat: [number, number]): Surface | null {
  return once(`leather:${tone}:${stitched}:${repeat.join('x')}`, () => {
    const width = 512;
    const height = 256;
    const canvas = makeCanvas(width, height);
    const bumpCanvas = makeCanvas(width, height);
    if (!canvas || !bumpCanvas) return null;

    const base: Rgb = tone === 'oxblood' ? [50, 13, 12] : [24, 17, 15];
    const dark: Rgb = tone === 'oxblood' ? [20, 5, 6] : [8, 6, 6];
    const heights = new Float32Array(width * height);

    const crease = coarse(width, height, 4, (u, v) => Math.abs(fbm(u * 28, v * 14, 3, 37, 14) - 0.5) * 2);
    const patina = coarse(width, height, 8, (u, v) => fbm(u * 4, v * 2, 3, 41, 2));

    fill(context(canvas), width, height, (x, y, out) => {
      // Pores: fine, and a little coarser underneath, so it is hide and not sand.
      const pore = grain(x, y, 31) * 0.45 + grain(x >> 1, y >> 1, 33) * 0.55;
      const fold = smoothstep(0.0, 0.14, crease(x, y));
      const h = pore * 0.45 + fold * 0.55;
      heights[y * width + x] = h;
      mixTo(out, dark, base, h * (0.6 + 0.55 * patina(x, y)));
    });

    const ctx = context(canvas);
    const bump = context(bumpCanvas);
    fill(bump, width, height, (x, y, out) => {
      out[0] = out[1] = out[2] = heights[y * width + x]! * 255;
    });

    if (stitched) {
      for (const row of [0.115, 0.385]) {
        // V runs up the canvas, so a row on the tube is measured from the bottom.
        const y = (1 - row) * height;
        // The seam is a groove; the thread stands a little proud of it.
        for (const [target, groove, thread] of [
          [ctx, 'rgba(8, 3, 3, 0.75)', 'rgb(150, 116, 74)'],
          [bump, 'rgb(20, 20, 20)', 'rgb(255, 255, 255)'],
        ] as const) {
          target.fillStyle = groove;
          target.fillRect(0, y - 2, width, 4);
          target.fillStyle = thread;
          for (let x = 1; x < width; x += 8) {
            target.beginPath();
            target.roundRect(x, y - 1.1, 5, 2.2, 1.1);
            target.fill();
          }
        }
      }
    }

    return {
      map: toTexture(canvas, { repeat }),
      bump: toTexture(bumpCanvas, { colour: false, repeat }),
    };
  });
}

// ---------------------------------------------------------------------------
// Wood
// ---------------------------------------------------------------------------

/**
 * Dark walnut, grain running along U. Tiles in both directions.
 *
 * Painted once and shared: every wooden thing in the room is the same plank at
 * a different scale, which costs one upload instead of three.
 */
function woodCanvases(): { map: HTMLCanvasElement; bump: HTMLCanvasElement } | null {
  return once('wood', () => {
    const size = 512;
    const canvas = makeCanvas(size, size);
    const bumpCanvas = makeCanvas(size, size);
    if (!canvas || !bumpCanvas) return null;

    const pale: Rgb = [58, 34, 20];
    const deep: Rgb = [15, 8, 6];
    const heights = new Float32Array(size * size);

    const warp = coarse(size, size, 8, (u, v) => fbm(u * 2, v * 4, 3, 22, 2));
    const drift = coarse(size, size, 8, (u, v) => fbm(u * 1, v * 2, 2, 23, 1));

    fill(context(canvas), size, size, (x, y, out) => {
      const u = x / size;
      const v = y / size;
      // Growth rings cut lengthwise: long bands that wander a little.
      const rings = 0.5 + 0.5 * Math.sin((v * 11 + warp(x, y) * 0.9 + drift(x, y) * 0.7) * Math.PI * 2);
      const streak = valueNoise(u * 6, v * 150, 24, 6);
      const pitted = grain(x >> 2, y, 25) > 0.86 ? 0.74 : 1;
      const tone = Math.pow(rings, 1.5) * 0.4 + streak * 0.6;
      mixTo(out, deep, pale, tone * 0.9, pitted);
      heights[y * size + x] = tone * 0.6 + (pitted < 1 ? 0 : 0.4);
    });
    fill(context(bumpCanvas), size, size, (x, y, out) => {
      out[0] = out[1] = out[2] = heights[y * size + x]! * 255;
    });
    return { map: canvas, bump: bumpCanvas };
  });
}

export function woodSurface(repeat: [number, number]): Surface | null {
  return once(`wood:${repeat.join('x')}`, () => {
    const canvases = woodCanvases();
    if (!canvases) return null;
    return {
      map: toTexture(canvases.map, { repeat }),
      bump: toTexture(canvases.bump, { colour: false, repeat }),
    };
  });
}

/**
 * Floorboards: long planks, butted end to end, with the gaps gone black.
 */
export function floorSurface(repeat: [number, number]): Surface | null {
  return once(`floor:${repeat.join('x')}`, () => {
    const size = 512;
    const canvas = makeCanvas(size, size);
    const bumpCanvas = makeCanvas(size, size);
    if (!canvas || !bumpCanvas) return null;

    const rows = 4;
    const rowHeight = size / rows;
    const random = seeded(77);
    // Where each row's boards end, and how each board differs from its neighbours.
    const joints = Array.from({ length: rows }, () => [random() * size, (random() * 0.3 + 0.3) * size]);
    const tints = Array.from({ length: rows * 3 }, () => 0.7 + random() * 0.55);

    const pale: Rgb = [46, 29, 18];
    const deep: Rgb = [13, 8, 6];
    const heights = new Float32Array(size * size);

    const warp = coarse(size, size, 8, (u, v) => fbm(u * 2, v * 4, 3, 81, 2));
    const scuff = coarse(size, size, 8, (u, v) => fbm(u * 9, v * 9, 3, 85, 9));

    fill(context(canvas), size, size, (x, y, out) => {
      const row = Math.floor(y / rowHeight);
      const within = (y % rowHeight) / rowHeight;
      const [first, gap] = joints[row]!;
      const along = (x - first! + size) % size;
      const board = along < gap! ? 0 : along < gap! * 1.9 ? 1 : 2;
      const toJoint = Math.min(along, size - along, Math.abs(along - gap!), Math.abs(along - gap! * 1.9));
      const seam = Math.min(within, 1 - within) * rowHeight;

      const u = x / size;
      const v = y / size;
      const rings = 0.5 + 0.5 * Math.sin((v * rows * 6 + warp(x, y) * 1.6 + row * 1.3 + board * 0.37) * Math.PI * 2);
      const streak = valueNoise(u * 5, v * 160, 83, 5);

      let tone = (rings * 0.4 + streak * 0.6) * tints[row * 3 + board]!;
      tone *= 0.7 + 0.5 * scuff(x, y);
      const crack = seam < 1.2 || toJoint < 1.1 ? 0.1 : seam < 2.6 || toJoint < 2.4 ? 0.6 : 1;
      mixTo(out, deep, pale, Math.min(tone, 1) * 0.9, crack);
      heights[y * size + x] = crack < 1 ? crack * 0.3 : 0.55 + tone * 0.45;
    });
    fill(context(bumpCanvas), size, size, (x, y, out) => {
      out[0] = out[1] = out[2] = heights[y * size + x]! * 255;
    });

    return {
      map: toTexture(canvas, { repeat }),
      bump: toTexture(bumpCanvas, { colour: false, repeat }),
    };
  });
}

// ---------------------------------------------------------------------------
// Walls and ceiling
// ---------------------------------------------------------------------------

/**
 * Damask: one motif, mirrored, in a half-drop repeat.
 *
 * The pattern is barely lighter than its ground. In this room it is not seen so
 * much as caught — a sconce picks out a metre of it and the rest is inference.
 */
export function wallpaperSurface(repeat: [number, number]): Surface | null {
  return once(`wallpaper:${repeat.join('x')}`, () => {
    const size = 512;
    const canvas = makeCanvas(size, size);
    if (!canvas) return null;
    const ctx = context(canvas);

    const grime = coarse(size, size, 8, (u, v) => fbm(u * 6, v * 6, 4, 91, 6));
    fill(ctx, size, size, (x, y, out) => {
      // A woven ground: threads one way, then the other.
      const weave = grain(x >> 1, y * 3, 93) * 0.5 + grain(x * 3, y >> 1, 95) * 0.5;
      mixTo(out, [50, 19, 19], [92, 38, 33], grime(x, y) * 0.7 + weave * 0.3);
    });

    // Drawn on its own layer so the veins can be cut out of it cleanly.
    const layer = makeCanvas(size, size)!;
    drawMotifs(context(layer), size);

    ctx.save();
    ctx.globalAlpha = 0.42;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();

    // Thin gilt pinstripes between the columns, mostly tarnished away.
    ctx.strokeStyle = `rgba(${GILT}, 0.14)`;
    ctx.lineWidth = 1.5;
    for (const x of [0.5, 256.5]) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size);
      ctx.stroke();
    }

    return { map: toTexture(canvas, { repeat }) };
  });
}

/** The damask motif, mirrored about its own axis, on a half-drop grid. */
function drawMotifs(ink: CanvasRenderingContext2D, size: number): void {
  const leaf = (): void => {
    for (const side of [-1, 1]) {
      ink.save();
      ink.scale(side, 1);
      ink.beginPath();
      ink.moveTo(0, -112);
      ink.bezierCurveTo(34, -84, 52, -40, 30, -6);
      ink.bezierCurveTo(60, -14, 86, 6, 78, 40);
      ink.bezierCurveTo(70, 70, 34, 72, 26, 48);
      ink.bezierCurveTo(40, 58, 58, 48, 54, 32);
      ink.bezierCurveTo(48, 14, 22, 18, 12, 40);
      ink.bezierCurveTo(8, 70, 20, 96, 0, 118);
      ink.closePath();
      ink.fill();
      ink.restore();
    }
    // Veins and an eye, cut back out so the ground shows through.
    ink.save();
    ink.globalCompositeOperation = 'destination-out';
    for (const side of [-1, 1]) {
      ink.save();
      ink.scale(side, 1);
      ink.beginPath();
      ink.moveTo(5, -82);
      ink.bezierCurveTo(22, -58, 30, -34, 15, -10);
      ink.bezierCurveTo(9, 8, 5, 30, 5, 58);
      ink.closePath();
      ink.fill();
      ink.beginPath();
      ink.ellipse(54, 36, 8, 12, 0.5, 0, Math.PI * 2);
      ink.fill();
      ink.restore();
    }
    ink.restore();
    ink.beginPath();
    ink.arc(0, -128, 7, 0, Math.PI * 2);
    ink.fill();
    ink.beginPath();
    ink.ellipse(0, 132, 5, 9, 0, 0, Math.PI * 2);
    ink.fill();
  };

  ink.fillStyle = 'rgb(170, 104, 66)';
  for (const [x, y] of [
    [128, 128],
    [128, 128 + size],
    [128, 128 - size],
    [384, 384],
    [384, 384 - size],
    [384, 384 + size],
  ] as const) {
    ink.save();
    ink.translate(x, y);
    leaf();
    ink.restore();
  }
}

/** Old plaster: stained, and beginning to craze. */
export function plasterSurface(repeat: [number, number]): Surface | null {
  return once(`plaster:${repeat.join('x')}`, () => {
    const size = 512;
    const canvas = makeCanvas(size, size);
    if (!canvas) return null;
    const ctx = context(canvas);

    const stain = coarse(size, size, 8, (u, v) => fbm(u * 3, v * 3, 5, 101, 3));
    fill(ctx, size, size, (x, y, out) => {
      mixTo(out, [34, 28, 24], [88, 78, 66], stain(x, y) * 0.8 + grain(x >> 1, y >> 1, 103) * 0.2);
    });

    // Hairline cracks, each wandering off from where it started.
    const random = seeded(109);
    ctx.strokeStyle = 'rgba(14, 10, 9, 0.6)';
    ctx.lineWidth = 1;
    for (let crack = 0; crack < 7; crack++) {
      let x = random() * size;
      let y = random() * size;
      let heading = random() * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let step = 0; step < 26; step++) {
        heading += (random() - 0.5) * 0.9;
        x += Math.cos(heading) * 9;
        y += Math.sin(heading) * 9;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    return { map: toTexture(canvas, { repeat }) };
  });
}

// ---------------------------------------------------------------------------
// The rug
// ---------------------------------------------------------------------------

/**
 * A round rug: bands of ornament about a medallion, sixteen times symmetric.
 *
 * Painted as a disc on a transparent ground; the mesh it goes on is a circle.
 */
export function rugSurface(): Surface | null {
  return once('rug', () => {
    const size = 768;
    const canvas = makeCanvas(size, size);
    if (!canvas) return null;
    const ctx = context(canvas);
    // The ornament below is drawn at 1024 and scaled to whatever `size` is.
    const drawn = 1024;
    ctx.scale(size / drawn, size / drawn);
    const c = drawn / 2;

    const band = (outer: number, inner: number, colour: string): void => {
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(c, c, outer * c, 0, Math.PI * 2);
      ctx.arc(c, c, inner * c, 0, Math.PI * 2, true);
      ctx.fill();
    };
    const around = (count: number, radius: number, draw: () => void, offset = 0): void => {
      for (let i = 0; i < count; i++) {
        ctx.save();
        ctx.translate(c, c);
        ctx.rotate(((i + offset) / count) * Math.PI * 2);
        ctx.translate(0, -radius * c);
        draw();
        ctx.restore();
      }
    };
    const diamond = (w: number, h: number): void => {
      ctx.beginPath();
      ctx.moveTo(0, -h);
      ctx.lineTo(w, 0);
      ctx.lineTo(0, h);
      ctx.lineTo(-w, 0);
      ctx.closePath();
      ctx.fill();
    };

    const WINE = 'rgb(84, 22, 24)';
    const INK = 'rgb(18, 20, 34)';
    const OCHRE = 'rgb(150, 110, 58)';
    const BONE = 'rgb(168, 150, 120)';

    band(0.985, 0, INK);
    band(0.95, 0.9, OCHRE);
    band(0.9, 0.74, WINE);
    band(0.74, 0.7, OCHRE);
    band(0.7, 0.42, INK);
    band(0.42, 0.39, OCHRE);
    band(0.39, 0, WINE);

    ctx.fillStyle = INK;
    around(48, 0.925, () => diamond(7, 9));
    ctx.fillStyle = BONE;
    around(32, 0.82, () => diamond(12, 24));
    ctx.fillStyle = INK;
    around(32, 0.82, () => diamond(5, 11));
    ctx.fillStyle = OCHRE;
    around(32, 0.82, () => diamond(4, 30), 0.5);
    ctx.fillStyle = WINE;
    around(16, 0.56, () => diamond(34, 58));
    ctx.fillStyle = OCHRE;
    around(16, 0.56, () => diamond(20, 38));
    ctx.fillStyle = INK;
    around(16, 0.56, () => diamond(9, 18));
    ctx.fillStyle = BONE;
    around(16, 0.56, () => diamond(7, 22), 0.5);
    ctx.fillStyle = OCHRE;
    around(16, 0.27, () => diamond(14, 44));
    ctx.fillStyle = INK;
    around(8, 0.14, () => diamond(16, 40));
    ctx.fillStyle = BONE;
    ctx.beginPath();
    ctx.arc(c, c, 0.045 * c, 0, Math.PI * 2);
    ctx.fill();

    // Trodden: faded overall, threadbare in patches, and the pile has a grain.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const half = size / 2;
    const worn = coarse(size, size, 8, (u, v) => fbm(u * 7, v * 7, 4, 121));
    const image = ctx.getImageData(0, 0, size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const r = Math.hypot(x - half, y - half) / half;
        if (r > 0.985) {
          // The fringe: threads, not an edge.
          const thread = r < 1 && valueNoise(Math.atan2(y - half, x - half) * 220, 0, 131) > 0.45;
          image.data[i + 3] = thread ? 200 : 0;
          image.data[i] = 96;
          image.data[i + 1] = 84;
          image.data[i + 2] = 66;
          continue;
        }
        const w = worn(x, y);
        const pile = grain(x, y, 123) * 0.5 + grain(x >> 2, y, 125) * 0.5;
        const fade = 0.36 + 0.26 * w + 0.16 * (pile - 0.5);
        const bare = smoothstep(0.62, 0.8, w) * 0.45;
        for (let k = 0; k < 3; k++) {
          const ground = [70, 58, 46][k]!;
          image.data[i + k] = (image.data[i + k]! * (1 - bare) + ground * bare) * fade;
        }
      }
    }
    ctx.putImageData(image, 0, 0);
    return { map: toTexture(canvas) };
  });
}

// ---------------------------------------------------------------------------
// Cloth
// ---------------------------------------------------------------------------

/** A weave, as height only: what makes a sleeve look like cloth and not paint. */
export function weaveBump(repeat: [number, number], coarse = false): Texture | null {
  return once(`weave:${repeat.join('x')}:${coarse}`, () => {
    const size = 128;
    const canvas = makeCanvas(size, size);
    if (!canvas) return null;
    const thread = coarse ? 8 : 4;
    fill(context(canvas), size, size, (x, y, out) => {
      const over = (Math.floor(x / thread) + Math.floor(y / thread)) % 2 === 0;
      const along = over ? (x % thread) / thread : (y % thread) / thread;
      const ridge = Math.sin(along * Math.PI);
      const slub = valueNoise(x * 0.5, y * 0.5, 141, 64);
      out[0] = out[1] = out[2] = (0.35 + 0.5 * ridge + 0.15 * slub) * 255;
    });
    return toTexture(canvas, { colour: false, repeat });
  });
}

// ---------------------------------------------------------------------------
// Things hung on the walls
// ---------------------------------------------------------------------------

/**
 * A portrait.
 *
 * Whoever sat for these, somebody has been at the eyes. Four sitters, so the
 * room can hang four without repeating itself.
 */
export function portraitTexture(sitter: number): Texture | null {
  return once(`portrait:${sitter}`, () => {
    const width = 256;
    const height = 320;
    const canvas = makeCanvas(width, height);
    if (!canvas) return null;
    const ctx = context(canvas);
    const random = seeded(500 + sitter * 37);

    // Ground: varnish gone brown, darker at the edges.
    const ground = ctx.createRadialGradient(width / 2, height * 0.42, 20, width / 2, height / 2, height * 0.75);
    ground.addColorStop(0, 'rgb(58, 44, 30)');
    ground.addColorStop(1, 'rgb(12, 9, 7)');
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, width, height);

    // Shoulders and collar.
    const coat = ['rgb(20, 18, 22)', 'rgb(34, 16, 16)', 'rgb(18, 26, 22)', 'rgb(30, 26, 20)'][sitter % 4]!;
    ctx.fillStyle = coat;
    ctx.beginPath();
    ctx.moveTo(18, height);
    ctx.bezierCurveTo(30, height * 0.7, 86, height * 0.66, width / 2, height * 0.64);
    ctx.bezierCurveTo(170, height * 0.66, 226, height * 0.7, 238, height);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgb(150, 138, 116)';
    ctx.beginPath();
    ctx.moveTo(width / 2 - 20, height * 0.66);
    ctx.lineTo(width / 2, height * 0.78);
    ctx.lineTo(width / 2 + 20, height * 0.66);
    ctx.closePath();
    ctx.fill();

    // The face: lit from above, like everybody in this house.
    const tilt = (random() - 0.5) * 0.12;
    ctx.save();
    ctx.translate(width / 2, height * 0.4);
    ctx.rotate(tilt);
    const skin = ctx.createLinearGradient(0, -70, 0, 80);
    skin.addColorStop(0, 'rgb(176, 150, 118)');
    skin.addColorStop(0.55, 'rgb(128, 100, 76)');
    skin.addColorStop(1, 'rgb(60, 44, 34)');
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(0, 0, 46 + random() * 8, 62 + random() * 8, 0, 0, Math.PI * 2);
    ctx.fill();
    // Hair, or the lack of it.
    ctx.fillStyle = ['rgb(14, 11, 10)', 'rgb(70, 62, 54)', 'rgb(34, 20, 12)', 'rgb(16, 14, 14)'][sitter % 4]!;
    ctx.beginPath();
    ctx.ellipse(0, -30, 52, 46, 0, Math.PI * (1.02 + (sitter % 2) * 0.06), Math.PI * 1.98);
    ctx.fill();
    // Brow shadow, nose, mouth.
    ctx.fillStyle = 'rgba(30, 20, 14, 0.55)';
    ctx.fillRect(-36, -16, 72, 12);
    ctx.fillRect(-5, -4, 10, 34);
    ctx.fillStyle = 'rgba(40, 14, 12, 0.7)';
    ctx.fillRect(-16, 38, 32, 4);

    // The eyes, scored out. Not carefully.
    ctx.strokeStyle = 'rgba(8, 4, 3, 0.95)';
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      for (let stroke = 0; stroke < 13; stroke++) {
        ctx.lineWidth = 1 + random() * 2.2;
        ctx.beginPath();
        ctx.moveTo(side * 19 + (random() - 0.5) * 30, -10 + (random() - 0.5) * 16);
        ctx.lineTo(side * 19 + (random() - 0.5) * 30, -10 + (random() - 0.5) * 16);
        ctx.stroke();
      }
    }
    ctx.restore();

    // Craquelure and a century of smoke.
    const smoke = coarse(width, height, 8, (u, v) => 0.5 + 0.5 * fbm(u * 4.3, v * 5.3, 4, 600 + sitter));
    const image = ctx.getImageData(0, 0, width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const crackle = Math.abs(valueNoise(x / 7, y / 7, 700 + sitter) - 0.5) < 0.014 ? 0.5 : 1;
        const dim = smoke(x, y) * crackle * 0.8;
        for (let k = 0; k < 3; k++) image.data[i + k] = image.data[i + k]! * dim;
      }
    }
    ctx.putImageData(image, 0, 0);
    return toTexture(canvas);
  });
}

// ---------------------------------------------------------------------------
// Chips and the button
// ---------------------------------------------------------------------------

/**
 * A chip, as light and shade only.
 *
 * The left three quarters of the canvas is the face, the right quarter is the
 * edge. White throughout, because the colour comes from the instance: one
 * texture serves every denomination. See `chips.ts` for how the UVs find it.
 */
export function chipSurface(): Surface | null {
  return once('chip', () => {
    const size = 256;
    const canvas = makeCanvas(size, size);
    const bumpCanvas = makeCanvas(size, size);
    if (!canvas || !bumpCanvas) return null;
    const ctx = context(canvas);
    const bump = context(bumpCanvas);

    const face = size * 0.75;
    const c = face / 2;

    for (const [target, ground] of [
      [ctx, 'rgb(226, 226, 226)'],
      [bump, 'rgb(150, 150, 150)'],
    ] as const) {
      target.fillStyle = ground;
      target.fillRect(0, 0, size, size);
    }

    // The face: a moulded rim, a ring of pips, and a recessed inlay.
    ctx.fillStyle = 'rgb(255, 255, 255)';
    ctx.beginPath();
    ctx.arc(c, c, c * 0.98, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgb(150, 150, 150)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(c, c, c * 0.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgb(168, 168, 168)';
    for (let pip = 0; pip < 18; pip++) {
      const angle = (pip / 18) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(c + Math.cos(angle) * c * 0.89, c + Math.sin(angle) * c * 0.89, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgb(196, 196, 196)';
    ctx.beginPath();
    ctx.arc(c, c, c * 0.56, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgb(128, 128, 128)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c, c, c * 0.56, 0, Math.PI * 2);
    ctx.stroke();
    // A spade in the middle, pressed in rather than printed.
    ctx.fillStyle = 'rgb(140, 140, 140)';
    ctx.font = `${Math.round(c * 0.62)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♠', c, c + 2);

    bump.fillStyle = 'rgb(210, 210, 210)';
    bump.beginPath();
    bump.arc(c, c, c * 0.98, 0, Math.PI * 2);
    bump.fill();
    bump.fillStyle = 'rgb(120, 120, 120)';
    bump.beginPath();
    bump.arc(c, c, c * 0.56, 0, Math.PI * 2);
    bump.fill();

    // The edge: darker where one chip meets the next, so a stack reads as chips.
    const edge = ctx.createLinearGradient(0, 0, 0, size);
    edge.addColorStop(0, 'rgb(96, 96, 96)');
    edge.addColorStop(0.16, 'rgb(240, 240, 240)');
    edge.addColorStop(0.84, 'rgb(240, 240, 240)');
    edge.addColorStop(1, 'rgb(96, 96, 96)');
    ctx.fillStyle = edge;
    ctx.fillRect(face, 0, size - face, size);

    return { map: toTexture(canvas, { anisotropy: 4 }), bump: toTexture(bumpCanvas, { colour: false }) };
  });
}

/** The dealer button: a white disc with a D on it, a little yellowed. */
export function buttonTexture(): Texture | null {
  return once('button', () => {
    const size = 128;
    const canvas = makeCanvas(size, size);
    if (!canvas) return null;
    const ctx = context(canvas);
    ctx.fillStyle = 'rgb(212, 202, 180)';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgb(70, 22, 20)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgb(24, 18, 16)';
    ctx.font = `bold ${Math.round(size * 0.52)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('D', size / 2, size / 2 + 4);
    return toTexture(canvas, { anisotropy: 4 });
  });
}

/** A soft round mote, for dust and for the glow round a flame. */
export function glowTexture(): Texture | null {
  return once('glow', () => {
    const size = 64;
    const canvas = makeCanvas(size, size);
    if (!canvas) return null;
    const ctx = context(canvas);
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.25, 'rgba(255, 255, 255, 0.55)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    return toTexture(canvas, { anisotropy: 1 });
  });
}
