import { BoxGeometry, type BufferAttribute } from 'three';
import { cellUv, type AtlasCell } from './card-atlas.js';
import { CARD } from './layout.js';
import { peelPoint } from './peel.js';

/**
 * The card as a piece of geometry.
 *
 * Subdivided along its length so it can *bend*. A card is not a rigid tile: the
 * whole point of a peek is that the near corner curls while the far edge stays
 * pinned to the felt, and you cannot do that with four vertices.
 *
 * Which face is which, once the card is lying flat (`rotation.x = -PI/2`):
 *
 *   face 4 (+Z)  the top, facing the ceiling
 *   face 5 (-Z)  the underside, against the felt
 *
 * Hole cards are dealt **face down**, so the top is always the back and the
 * printed face is underneath. That is the arrangement the whole peek mechanic
 * depends on, and it is also the safer one: the face is on the side of the card
 * nobody can see without its owner bending it toward themselves.
 */

export const TOP_FACE = 4;
export const UNDERSIDE = 5;

/**
 * Segments along the card's length.
 *
 * Ten is enough that the curl reads as a curve rather than a hinge, and small
 * enough that twelve hole cards are still a rounding error against a scene that
 * costs a hundred and seventy draw calls.
 */
export const CARD_SEGMENTS = { width: 1, height: 10, depth: 1 } as const;

interface VertexRange {
  start: number;
  count: number;
}

/**
 * Which vertices belong to which face of a `BoxGeometry`.
 *
 * Three.js builds a box as six planes in a fixed order — +X, -X, +Y, -Y, +Z, -Z
 * — appending `(segsX + 1) * (segsY + 1)` vertices for each. That order is not
 * documented as a guarantee, so `card-mesh.test.ts` checks every range actually
 * lies on the plane it claims: if a future three.js reorders them, the test says
 * so instead of the cards silently rendering their backs on their faces.
 */
export function faceVertexRanges(
  widthSegments = CARD_SEGMENTS.width,
  heightSegments = CARD_SEGMENTS.height,
  depthSegments = CARD_SEGMENTS.depth,
): VertexRange[] {
  const counts = [
    (depthSegments + 1) * (heightSegments + 1), // +X
    (depthSegments + 1) * (heightSegments + 1), // -X
    (widthSegments + 1) * (depthSegments + 1), // +Y
    (widthSegments + 1) * (depthSegments + 1), // -Y
    (widthSegments + 1) * (heightSegments + 1), // +Z
    (widthSegments + 1) * (heightSegments + 1), // -Z
  ];

  const ranges: VertexRange[] = [];
  let start = 0;
  for (const count of counts) {
    ranges.push({ start, count });
    start += count;
  }
  return ranges;
}

/** A flat card, subdivided so it can be peeled. */
export function makeCardGeometry(): BoxGeometry {
  const geometry = new BoxGeometry(
    CARD.width,
    CARD.height,
    CARD.thickness,
    CARD_SEGMENTS.width,
    CARD_SEGMENTS.height,
    CARD_SEGMENTS.depth,
  );
  // Kept so every peel is computed from the flat card rather than from the last
  // frame's shape, which would accumulate error into a banana.
  const position = geometry.getAttribute('position') as BufferAttribute;
  geometry.userData['rest'] = Float32Array.from(position.array);
  return geometry;
}

/**
 * Points one face of the card at one cell of the atlas.
 *
 * `BoxGeometry` gives every face UVs across the full 0..1 square, so this is a
 * remap rather than an assignment, and it works whatever the subdivision is.
 */
export function setFaceCell(geometry: BoxGeometry, face: number, cell: AtlasCell): void {
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  const range = faceVertexRanges()[face];
  if (!range) return;

  const rect = cellUv(cell);
  const width = rect.uMax - rect.uMin;
  const height = rect.vMax - rect.vMin;

  const source = (geometry.userData['restUv'] ??= Float32Array.from(uv.array)) as Float32Array;
  for (let i = range.start; i < range.start + range.count; i++) {
    uv.setXY(i, rect.uMin + source[i * 2]! * width, rect.vMin + source[i * 2 + 1]! * height);
  }
  uv.needsUpdate = true;
}

/**
 * Bends the card.
 *
 * Every vertex is displaced by the same pure function of where it sits on the
 * flat card, so the six faces stay welded together at their seams without any
 * of them knowing about each other.
 */
export function applyPeel(geometry: BoxGeometry, bend: number): void {
  const position = geometry.getAttribute('position') as BufferAttribute;
  const rest = geometry.userData['rest'] as Float32Array;

  for (let i = 0; i < position.count; i++) {
    const x = rest[i * 3]!;
    const y = rest[i * 3 + 1]!;
    const z = rest[i * 3 + 2]!;
    const peeled = peelPoint(x, y, z, bend);
    position.setXYZ(i, x, peeled.y, peeled.z);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}
