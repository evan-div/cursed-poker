import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { resolveGaze, gazePoint } from './gaze.js';
import { EYE_HEIGHT, RADIUS, TABLE, seatPoint, seatedView } from './layout.js';

/**
 * Where a look lands.
 *
 * Built on a real `PerspectiveCamera` rather than on hand-written direction
 * vectors, for the same reason `layout.test.ts` is: the -Z convention is the one
 * thing in this scene that is easy to restate wrongly in both the code and the
 * test. Asking Three.js which way a camera is pointing is the only check that
 * can actually fail.
 */

const SEATS = [0, 1, 2, 3, 4, 5];

/** A camera seated at `seat`, aimed at a point in the world. */
function looking(seat: number, at: { x: number; y: number; z: number }) {
  const view = seatedView(seat);
  const camera = new PerspectiveCamera(58, 16 / 9, 0.02, 40);
  camera.position.set(view.position.x, view.position.y, view.position.z);
  camera.lookAt(at.x, at.y, at.z);
  camera.updateMatrixWorld(true);

  const forward = new Vector3();
  camera.getWorldDirection(forward);
  return { eye: view.position, forward };
}

describe('resolving a gaze', () => {
  it('sees the person you are looking at', () => {
    for (const viewer of SEATS) {
      for (const other of SEATS) {
        if (other === viewer) continue;
        const face = seatPoint(other, RADIUS.body, 1.21);
        const { eye, forward } = looking(viewer, face);
        expect(resolveGaze(eye, forward, viewer, SEATS)).toEqual({
          kind: 'SEAT',
          seatIndex: other,
        });
      }
    }
  });

  it('sees the Dealer across the table', () => {
    for (const viewer of SEATS) {
      const dealer = gazePoint({ kind: 'DEALER' }, viewer)!;
      const { eye, forward } = looking(viewer, dealer);
      expect(resolveGaze(eye, forward, viewer, SEATS).kind).toBe('DEALER');
    }
  });

  it('tells your own cards apart from your own chips', () => {
    for (const viewer of SEATS) {
      const cards = looking(viewer, seatPoint(viewer, RADIUS.holeCards, TABLE.surfaceHeight));
      expect(resolveGaze(cards.eye, cards.forward, viewer, SEATS).kind).toBe('OWN_CARDS');

      const chips = looking(viewer, seatPoint(viewer, RADIUS.chips, TABLE.surfaceHeight));
      expect(resolveGaze(chips.eye, chips.forward, viewer, SEATS).kind).toBe('OWN_CHIPS');
    }
  });

  it('finds the board and the pot in the middle of the table', () => {
    for (const viewer of SEATS) {
      const board = looking(viewer, gazePoint({ kind: 'BOARD' }, viewer)!);
      expect(resolveGaze(board.eye, board.forward, viewer, SEATS).kind).toBe('BOARD');

      const pot = looking(viewer, gazePoint({ kind: 'POT' }, viewer)!);
      expect(resolveGaze(pot.eye, pot.forward, viewer, SEATS).kind).toBe('POT');
    }
  });

  it('says AWAY when a player is looking at nothing in particular', () => {
    // Straight up at the ceiling, and out into the dark behind the table.
    const eye = seatedView(2).position;
    for (const at of [
      { x: eye.x, y: 6, z: eye.z },
      { x: eye.x * 8, y: EYE_HEIGHT, z: eye.z * 8 },
    ]) {
      const camera = new PerspectiveCamera();
      camera.position.set(eye.x, eye.y, eye.z);
      camera.lookAt(at.x, at.y, at.z);
      camera.updateMatrixWorld(true);
      const forward = new Vector3();
      camera.getWorldDirection(forward);
      expect(resolveGaze(eye, forward, 2, SEATS)).toEqual({ kind: 'AWAY' });
    }
  });

  it('does not fall over on a degenerate direction', () => {
    const eye = seatedView(0).position;
    expect(resolveGaze(eye, { x: 0, y: 0, z: 0 }, 0, SEATS)).toEqual({ kind: 'AWAY' });
    expect(resolveGaze(eye, { x: Number.NaN, y: 0, z: 1 }, 0, SEATS)).toEqual({ kind: 'AWAY' });
  });

  it('never offers a seat that is not at the table', () => {
    const { eye, forward } = looking(0, seatPoint(3, RADIUS.body, 1.21));
    // Seat 3 has been eliminated, so nobody is there to be looked at.
    const target = resolveGaze(eye, forward, 0, [0, 1, 2, 4, 5]);
    expect(target.kind === 'SEAT' && target.seatIndex === 3).toBe(false);
  });
});

describe('turning a head toward a gaze', () => {
  it('round-trips every target back to a point a head can face', () => {
    for (const target of [
      { kind: 'DEALER' },
      { kind: 'BOARD' },
      { kind: 'POT' },
      { kind: 'OWN_CARDS' },
      { kind: 'OWN_CHIPS' },
      { kind: 'SEAT', seatIndex: 4 },
    ] as const) {
      const point = gazePoint(target, 1);
      expect(point).not.toBeNull();
      expect(Number.isFinite(point!.x + point!.y + point!.z)).toBe(true);
    }
    expect(gazePoint({ kind: 'AWAY' }, 1)).toBeNull();
  });

  it('resolves "their own cards" against the seat doing the looking', () => {
    expect(gazePoint({ kind: 'OWN_CARDS' }, 0)).not.toEqual(gazePoint({ kind: 'OWN_CARDS' }, 3));
  });
});
