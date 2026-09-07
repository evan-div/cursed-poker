import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { LEAN } from '@cursed/shared';
import { SeatedCamera } from './seated-camera.js';
import { EYE_HEIGHT, seatedView } from './layout.js';

/**
 * Sitting down, and leaning in.
 *
 * The camera had no test until a seat change stopped moving it: the lean logic
 * skips its work when the posture has not changed, which is correct every frame
 * and disastrous the one time the *seat* changed instead. The result was a
 * player sitting in the Dealer's chair looking out along their own seat's
 * heading, and it took a screenshot to notice.
 */

function distanceToCentre(camera: SeatedCamera): number {
  return Math.hypot(camera.camera.position.x, camera.camera.position.z);
}

describe('sitting down', () => {
  it('puts the camera at the seat it was given', () => {
    const camera = new SeatedCamera(16 / 9);
    for (const seatIndex of [0, 1, 2, 3, 4, 5]) {
      camera.sitAt(seatIndex);
      const seat = seatedView(seatIndex);
      expect(camera.camera.position.x).toBeCloseTo(seat.position.x, 6);
      expect(camera.camera.position.y).toBeCloseTo(seat.position.y, 6);
      expect(camera.camera.position.z).toBeCloseTo(seat.position.z, 6);
    }
  });

  it('moves when the player changes seats', () => {
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(0);
    const first = camera.camera.position.clone();
    camera.sitAt(3);
    expect(camera.camera.position.distanceTo(first)).toBeGreaterThan(0.5);
  });

  it('seats a viewer with no seat in the Dealer\'s place', () => {
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(null);
    const dealer = seatedView(null);
    expect(camera.camera.position.x).toBeCloseTo(dealer.position.x, 6);
    expect(camera.camera.position.z).toBeCloseTo(dealer.position.z, 6);
  });

  it('sits back up when it moves', () => {
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(1);
    camera.leanTo(1);
    expect(camera.lean).toBe(1);
    camera.sitAt(4);
    expect(camera.lean).toBe(0);
    expect(camera.camera.position.y).toBeCloseTo(EYE_HEIGHT, 6);
  });
});

describe('leaning in', () => {
  it('moves the head along the line of sight and narrows the view', () => {
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(2);
    const seat = seatedView(2).position;
    const back = distanceToCentre(camera);
    const restFov = camera.camera.fov;

    camera.leanTo(1);
    // The head travels exactly its reach, whichever way it was pointing.
    expect(camera.camera.position.distanceTo(new Vector3(seat.x, seat.y, seat.z))).toBeCloseTo(
      LEAN.reach,
      6,
    );
    expect(distanceToCentre(camera)).toBeLessThan(back);
    expect(camera.camera.fov).toBeLessThan(restFov);
    expect(camera.camera.fov).toBeCloseTo(LEAN.closeFov, 6);
  });

  it('goes down toward the cards when the player is looking down at them', () => {
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(0);
    const level = new SeatedCamera(16 / 9);
    level.sitAt(0);

    // Craning at your own hand is mostly a downward movement; craning at the
    // board across the table is mostly a forward one. Leaning toward the middle
    // of the table did the second thing in both cases, and pushed your head
    // straight over your own cards.
    camera.lookAt(0, -1.1);
    camera.leanTo(1);
    level.lookAt(0, 0);
    level.leanTo(1);

    const dropped = seatedView(0).position.y - camera.camera.position.y;
    const flat = seatedView(0).position.y - level.camera.position.y;
    expect(dropped).toBeGreaterThan(flat);
    expect(dropped).toBeGreaterThan(LEAN.reach * 0.7);
    expect(Math.abs(flat)).toBeLessThan(1e-9);
  });

  it('drops the head as it comes forward, rather than gliding flat', () => {
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(0);
    camera.leanTo(1);
    expect(camera.camera.position.y).toBeLessThan(EYE_HEIGHT);
  });

  it('is a posture, not a spring: it stays where it is put', () => {
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(0);
    camera.leanTo(0.5);
    for (let i = 0; i < 120; i++) camera.update(1 / 60, 1_000 + i * 16);
    expect(camera.lean).toBe(0.5);
  });

  it('brings the head down to a card as it is lifted', () => {
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(0);
    const seat = seatedView(0).position;

    camera.setPeekLean(1);
    const moved = camera.camera.position.distanceTo(new Vector3(seat.x, seat.y, seat.z));
    expect(moved).toBeGreaterThan(LEAN.reach * 0.5);
    // The head moves; the view does not narrow. Cropping the frustum while
    // somebody bends over their own cards pushes those cards off the bottom of
    // the screen, which is exactly backwards.
    expect(camera.camera.fov).toBe(LEAN.restFov);

    // Letting go sits back up.
    camera.setPeekLean(0);
    expect(camera.camera.position.distanceTo(new Vector3(seat.x, seat.y, seat.z))).toBeCloseTo(0, 6);
  });

  it('does not report bending over a card as a chosen posture', () => {
    // The table already learns about the peek. Reporting the head movement it
    // causes as a lean too would show everybody somebody hunching over nothing.
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(0);
    camera.setPeekLean(1);
    expect(camera.lean).toBe(0);
  });

  it('takes whichever is further, rather than stacking them', () => {
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(0);
    camera.leanTo(1);
    const forward = camera.camera.position.clone();
    camera.setPeekLean(1);
    expect(camera.camera.position.distanceTo(forward)).toBeCloseTo(0, 6);
  });

  it('clamps to what a person could do without standing up', () => {
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(0);
    camera.leanTo(5);
    expect(camera.lean).toBe(1);
    camera.leanTo(-5);
    expect(camera.lean).toBe(0);
  });
});
