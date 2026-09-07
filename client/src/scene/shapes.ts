import { BufferGeometry, CapsuleGeometry } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Solids with the corners taken off.
 *
 * Everything in this room is a primitive built at runtime, which is the right
 * trade — nothing to load, nothing to version, and the whole game changes shape
 * by editing numbers. What it is *not* obliged to be is a pile of cubes. A hard
 * 90° edge is the single loudest signal that something was assembled out of
 * boxes: it catches the lamp in a dead-straight line, it silhouettes against the
 * fog as a rectangle, and no amount of good lighting hides it.
 *
 * A rounded edge fixes that for almost nothing. The corner picks up a gradient
 * instead of a step, the silhouette softens, and the one lamp over the table
 * suddenly has something to model. The shapes stay simple and readable, which
 * matters: the horror here is behaviour, and a body still has to read its own
 * trembling from across a dark table.
 *
 * Two rules, because six bodies plus a Dealer plus seven chairs is a lot of
 * geometry to build twice:
 *
 * - **Everything is cached by its dimensions.** Ask for the same solid twice and
 *   you get the same `BufferGeometry`, uploaded to the GPU once. Six avatars
 *   share one torso, sixty fingers share four bones.
 * - **Nobody disposes of these.** They live as long as the page does, on
 *   purpose. A cache that hands out shared geometry and also lets a caller free
 *   it is a cache that eventually hands out a freed one.
 */

const cache = new Map<string, BufferGeometry>();

function cached(key: string, make: () => BufferGeometry): BufferGeometry {
  const existing = cache.get(key);
  if (existing) return existing;
  const made = make();
  cache.set(key, made);
  return made;
}

/**
 * How round a corner is, as a fraction of the solid's smallest side.
 *
 * A quarter is enough to kill the hard edge and not enough to turn a torso into
 * a pill. Anything much past a third and small parts — a chair leg, a knuckle —
 * stop being able to hold their own shape.
 */
const CORNER = 0.24;

/**
 * How many facets each rounded corner gets.
 *
 * Two is the whole difference between "cube" and "not a cube"; three is barely
 * distinguishable from two on anything smaller than a torso, and this scene has
 * a hundred and forty of these in it.
 */
const CORNER_STEPS = 2;

/** A box with its edges rounded off. Dimensions are the box's full extents. */
export function roundedBox(width: number, height: number, depth: number): BufferGeometry {
  const radius = Math.min(width, height, depth) * CORNER;
  return cached(`box:${width}:${height}:${depth}`, () =>
    // The addon's own arguments, in its own order: it takes the radius last.
    new RoundedBoxGeometry(width, height, depth, CORNER_STEPS, radius),
  );
}

/**
 * A limb bone: a cylinder with domed ends, running along its own **+Z**.
 *
 * +Z rather than the +Y a capsule is born with, because every joint in
 * `body.ts` points down its own +Z at the next one, and a bone that has to be
 * rotated at every call site is a bone that will eventually be rotated wrongly
 * at one of them.
 *
 * `length` is the whole thing end to end, domes included, so a bone still spans
 * exactly the joint it was measured from. The rounded ends are also what makes
 * an elbow look like a joint: two boxes meeting at an angle leave a notch on the
 * inside of the bend and a corner sticking out of the outside, and a limb that
 * did that read as a pair of planks with a hinge between them.
 */
export function bone(length: number, thickness: number): BufferGeometry {
  const radius = Math.min(thickness / 2, length / 2);
  const middle = Math.max(length - radius * 2, 0);
  return cached(`bone:${length}:${thickness}`, () => {
    // Facets by size. A finger is two centimetres thick and there are sixty of
    // them at this table; an upper arm is five times that and there are twelve.
    // Giving them the same tessellation means either faceted arms or twenty
    // thousand triangles of knuckle nobody can resolve.
    const fine = thickness > 0.04;
    const geometry = new CapsuleGeometry(radius, middle, fine ? 4 : 2, fine ? 12 : 8);
    geometry.rotateX(Math.PI / 2);
    return geometry;
  });
}
