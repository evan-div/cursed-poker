import { describe, expect, it } from 'vitest';
import type { BufferAttribute } from 'three';
import { PEEK } from '@cursed/shared';
import {
  CARD_SEGMENTS,
  TOP_FACE,
  UNDERSIDE,
  applyPeel,
  faceVertexRanges,
  makeCardGeometry,
} from './card-mesh.js';
import { CARD } from './layout.js';
import { peelAngle } from './peel.js';

/**
 * The card as geometry.
 *
 * `faceVertexRanges` encodes an assumption about how three.js builds a box —
 * six planes in a fixed order, so many vertices each. That is not a documented
 * guarantee, and if it ever changed the failure would be silent and awful: hole
 * cards would render their backs where their faces go, which is to say they
 * would show the whole table everybody's hand. So the assumption is checked
 * against the geometry rather than trusted.
 */

function positions(geometry: ReturnType<typeof makeCardGeometry>): BufferAttribute {
  return geometry.getAttribute('position') as BufferAttribute;
}

describe('which vertices belong to which face', () => {
  it('accounts for every vertex exactly once', () => {
    const geometry = makeCardGeometry();
    const ranges = faceVertexRanges();
    const total = ranges.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(positions(geometry).count);

    let expected = 0;
    for (const range of ranges) {
      expect(range.start).toBe(expected);
      expected += range.count;
    }
  });

  it('finds each face actually lying on the plane it claims', () => {
    const geometry = makeCardGeometry();
    const p = positions(geometry);
    const ranges = faceVertexRanges();

    // +X, -X, +Y, -Y, +Z, -Z — the order the ranges are returned in.
    const planes = [
      { axis: 'x', at: CARD.width / 2 },
      { axis: 'x', at: -CARD.width / 2 },
      { axis: 'y', at: CARD.height / 2 },
      { axis: 'y', at: -CARD.height / 2 },
      { axis: 'z', at: CARD.thickness / 2 },
      { axis: 'z', at: -CARD.thickness / 2 },
    ] as const;

    ranges.forEach((range, face) => {
      const plane = planes[face]!;
      for (let i = range.start; i < range.start + range.count; i++) {
        const value = plane.axis === 'x' ? p.getX(i) : plane.axis === 'y' ? p.getY(i) : p.getZ(i);
        // Seven places, not nine: the buffer is float32, so the geometry's own
        // corners land a nanometre off the numbers that produced them.
        expect(value, `face ${face} vertex ${i} is not on ${plane.axis}=${plane.at}`).toBeCloseTo(
          plane.at,
          7,
        );
      }
    });
  });

  it('puts the top and the underside where the renderer thinks they are', () => {
    const geometry = makeCardGeometry();
    const p = positions(geometry);
    const ranges = faceVertexRanges();

    // The card is laid flat with `rotation.x = -PI/2`, which points local +Z at
    // the ceiling. The top is where the back is printed; the underside is where
    // a hole card's face is, against the felt.
    const top = ranges[TOP_FACE]!;
    const under = ranges[UNDERSIDE]!;
    expect(p.getZ(top.start)).toBeCloseTo(CARD.thickness / 2, 7);
    expect(p.getZ(under.start)).toBeCloseTo(-CARD.thickness / 2, 7);
  });

  it('subdivides along the card so it has something to bend with', () => {
    expect(CARD_SEGMENTS.height).toBeGreaterThan(4);
    const along = new Set<number>();
    const geometry = makeCardGeometry();
    const p = positions(geometry);
    const range = faceVertexRanges()[TOP_FACE]!;
    for (let i = range.start; i < range.start + range.count; i++) {
      along.add(Number(p.getY(i).toFixed(6)));
    }
    expect(along.size).toBe(CARD_SEGMENTS.height + 1);
  });
});

describe('bending the mesh', () => {
  it('leaves a flat card exactly flat', () => {
    const geometry = makeCardGeometry();
    const before = Float32Array.from(positions(geometry).array);
    applyPeel(geometry, 0);
    expect(Array.from(positions(geometry).array)).toEqual(Array.from(before));
  });

  it('lifts vertices off the felt without moving the far edge', () => {
    const geometry = makeCardGeometry();
    applyPeel(geometry, peelAngle(1));
    const p = positions(geometry);

    let lifted = 0;
    for (let i = 0; i < p.count; i++) {
      if (p.getZ(i) > CARD.thickness) lifted++;
      // The far edge of the card is pinned to the table, whatever happens.
      if (p.getY(i) > CARD.height * 0.2) expect(Math.abs(p.getZ(i))).toBeLessThanOrEqual(CARD.thickness);
    }
    expect(lifted).toBeGreaterThan(10);
  });

  it('always bends from flat, so repeated peels do not accumulate', () => {
    const once = makeCardGeometry();
    applyPeel(once, peelAngle(0.7));

    const many = makeCardGeometry();
    for (const exposure of [0.2, 0.9, 0.4, 1, 0.7]) applyPeel(many, peelAngle(exposure));

    expect(Array.from(positions(many).array)).toEqual(Array.from(positions(once).array));
  });

  it('keeps the card together — no face tears away from its neighbours', () => {
    const geometry = makeCardGeometry();
    applyPeel(geometry, PEEK.maxLift);
    const p = positions(geometry);

    // Vertices that started life at the same spot must still be at the same
    // spot: the displacement is a pure function of where a vertex was, so the
    // duplicated vertices along every seam move together.
    const rest = geometry.userData['rest'] as Float32Array;
    const seen = new Map<string, string>();
    for (let i = 0; i < p.count; i++) {
      const from = [rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]].join(',');
      const to = [p.getX(i), p.getY(i), p.getZ(i)].map((v) => v.toFixed(9)).join(',');
      const already = seen.get(from);
      if (already !== undefined) expect(to, `seam split at ${from}`).toBe(already);
      seen.set(from, to);
    }
  });
});
