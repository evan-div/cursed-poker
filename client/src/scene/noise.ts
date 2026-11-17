/**
 * Repeatable randomness for things that are painted rather than played.
 *
 * Every texture in the room is drawn at start-up from numbers, and every one of
 * them has to come out the same on every machine: six players are looking at
 * the same stain on the same felt, and "is that mark new?" should be a question
 * about the game, never about whose browser rolled what. So nothing here touches
 * `Math.random`, and everything takes a seed.
 *
 * This is decoration's source of chance and nothing else's. It has no path to
 * the deck, the Dealer or composure, which each have their own on the server.
 */

/** A small, fast, well-mixed generator (mulberry32). Returns values in [0, 1). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A lattice hash: the same two integers always give the same value in [0, 1). */
function lattice(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
}

const wrap = (value: number, period: number): number => ((value % period) + period) % period;

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * Smooth value noise in [0, 1).
 *
 * With a `period`, the pattern repeats exactly every `period` units on both
 * axes, which is what lets a texture tile without a seam: wood grain on a wall
 * that visibly restarts every metre is worse than no grain.
 */
export function valueNoise(x: number, y: number, seed = 0, period = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);

  const at = (ix: number, iy: number): number =>
    period > 0 ? lattice(wrap(ix, period), wrap(iy, period), seed) : lattice(ix, iy, seed);

  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Several octaves of the above, summed: large shapes with detail on them.
 *
 * Normalised back into [0, 1). A `period` is doubled with each octave so the
 * sum still tiles.
 */
export function fbm(x: number, y: number, octaves: number, seed = 0, period = 0): number {
  let total = 0;
  let amplitude = 0.5;
  let reach = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    total += valueNoise(x * frequency, y * frequency, seed + octave * 101, period * frequency) * amplitude;
    reach += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / reach;
}
