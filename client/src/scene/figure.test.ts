import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { LOOKS, beadGeometry, headGeometry, headPoint, lookFor, shoulderGeometry, torsoGeometry } from './figure.js';

const dir = (x: number, y: number, z: number) => new Vector3(x, y, z).normalize();

describe('a head', () => {
  it('is the same on both sides', () => {
    for (const [x, y, z] of [
      [0.4, 0.07, 0.9],
      [0.8, -0.5, 0.3],
      [0.3, 0.6, -0.7],
    ] as const) {
      const right = headPoint(dir(x, y, z));
      const left = headPoint(dir(-x, y, z));
      expect(left.x).toBeCloseTo(-right.x, 12);
      expect(left.y).toBeCloseTo(right.y, 12);
      expect(left.z).toBeCloseTo(right.z, 12);
    }
  });

  it('has a face: a nose that stands out and sockets that sit back', () => {
    const nose = headPoint(dir(0, -0.12, 1)).z;
    const socket = headPoint(dir(0.4, 0.07, 0.91)).z;
    const brow = headPoint(dir(0.4, 0.25, 0.88)).z;
    // Under a lamp straight overhead, a brow in front of a socket is what puts
    // every eye at the table in shadow. It is the reason the head is sculpted.
    expect(nose).toBeGreaterThan(socket + 0.02);
    expect(brow).toBeGreaterThan(socket + 0.005);
  });

  it('keeps its width down to a jaw instead of tapering to a point', () => {
    // The lesson the first sphere of a head taught: a jaw that narrows to
    // nothing reads as more neck.
    const temple = Math.abs(headPoint(dir(1, 0, 0)).x);
    const jaw = Math.abs(headPoint(dir(1, -0.75, 0)).x);
    expect(jaw).toBeGreaterThan(temple * 0.5);
  });

  it('is the size of a head', () => {
    const size = new Box3().setFromBufferAttribute(headGeometry().getAttribute('position') as never).getSize(new Vector3());
    expect(size.x).toBeGreaterThan(0.15);
    expect(size.x).toBeLessThan(0.22);
    expect(size.y).toBeGreaterThan(0.19);
    expect(size.y).toBeLessThan(0.24);
  });

  it('sweats on its skin, not in the air in front of it', () => {
    const beads = new Box3().setFromBufferAttribute(beadGeometry().getAttribute('position') as never);
    const head = new Box3().setFromBufferAttribute(headGeometry().getAttribute('position') as never);
    // Within a bead's own size of the head, on every side.
    expect(beads.max.z).toBeLessThan(head.max.z + 0.012);
    expect(beads.min.x).toBeGreaterThan(head.min.x - 0.012);
    expect(beads.max.x).toBeLessThan(head.max.x + 0.012);
    expect(beads.min.y).toBeGreaterThan(-0.03);
  });
});

describe('six people', () => {
  it('gives every seat a look of its own', () => {
    const looks = [0, 1, 2, 3, 4, 5].map(lookFor);
    expect(new Set(looks).size).toBe(6);
    // Told apart across a dark table by silhouette, so no two share a head of hair.
    expect(new Set(looks.map((look) => look.hair)).size).toBe(6);
    expect(new Set(looks.map((look) => look.skin)).size).toBe(6);
  });

  it('wraps rather than failing for a seat it has no look for', () => {
    expect(lookFor(LOOKS.length)).toBe(lookFor(0));
  });

  it('dresses a torso: a coat with something lighter showing at the throat', () => {
    for (const look of LOOKS) {
      const geometry = torsoGeometry(look);
      const colours = geometry.getAttribute('color');
      expect(colours.count).toBe(geometry.getAttribute('position').count);
      const seen = new Set<string>();
      for (let i = 0; i < colours.count; i++) {
        seen.add(`${colours.getX(i).toFixed(3)},${colours.getY(i).toFixed(3)},${colours.getZ(i).toFixed(3)}`);
      }
      // The coat, its lapels, and at least the shirt.
      expect(seen.size).toBeGreaterThanOrEqual(3);
    }
  });

  it('builds a body about the size the old one was, so chairs and arms still fit', () => {
    const torso = new Box3().setFromBufferAttribute(torsoGeometry(LOOKS[0]!).getAttribute('position') as never).getSize(new Vector3());
    expect(torso.x).toBeGreaterThan(0.32);
    expect(torso.x).toBeLessThan(0.42);
    expect(torso.y).toBeGreaterThan(0.42);
    expect(torso.y).toBeLessThan(0.5);

    const shoulders = new Box3().setFromBufferAttribute(shoulderGeometry(LOOKS[0]!).getAttribute('position') as never).getSize(new Vector3());
    expect(shoulders.x).toBeGreaterThan(0.38);
    expect(shoulders.x).toBeLessThan(0.46);
  });
});
