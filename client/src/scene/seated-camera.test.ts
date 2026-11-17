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
    expect(moved).toBeCloseTo(LEAN.peekReach, 6);
    expect(LEAN.peekReach).toBeGreaterThan(LEAN.reach);
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
    const seat = new Vector3(
      seatedView(0).position.x,
      seatedView(0).position.y,
      seatedView(0).position.z,
    );

    // Bending over a card reaches further than leaning at the board, so doing
    // both is the further of the two and not the sum: you have one head.
    camera.leanTo(1);
    camera.setPeekLean(1);
    expect(camera.camera.position.distanceTo(seat)).toBeCloseTo(LEAN.peekReach, 6);

    // And the shorter one does not shorten the longer.
    camera.leanTo(0);
    expect(camera.camera.position.distanceTo(seat)).toBeCloseTo(LEAN.peekReach, 6);
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

describe('shaking', () => {
  it('moves what you see', () => {
    const camera = new SeatedCamera(16 / 9);
    camera.sitAt(2);
    camera.update(1 / 60, 1_000);
    const still = camera.camera.rotation.clone();
    camera.setShake({ yaw: 0.01, pitch: -0.008, roll: 0.004 });
    camera.update(1 / 60, 1_016);
    expect(camera.camera.rotation.y).toBeCloseTo(still.y + 0.01, 6);
    expect(camera.camera.rotation.x).toBeCloseTo(still.x - 0.008, 6);
    expect(camera.camera.rotation.z).toBeCloseTo(0.004, 6);
  });

  it('never changes where the table is told you are looking', () => {
    // Gaze is replicated. Resolved from a shaking camera, it would flicker
    // between neighbours at the rate your hands shook — a transcript of your
    // heart, sent to everybody, at far better resolution than the tell the
    // server deliberately quantises. So it is resolved from where you meant to
    // look, and a violently shaking head reports exactly what a still one does.
    const steady = new SeatedCamera(16 / 9);
    const shaking = new SeatedCamera(16 / 9);
    const reports = { steady: [] as string[], shaking: [] as string[] };
    for (const [camera, log] of [
      [steady, reports.steady],
      [shaking, reports.shaking],
    ] as const) {
      camera.sitAt(0);
      camera.setSeats([0, 1, 2, 3, 4, 5]);
      camera.onGazeChanged = (target) => log.push(JSON.stringify(target));
    }

    let seed = 12_345;
    const noise = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return (seed / 2 ** 32 - 0.5) * 0.4;
    };
    // A slow sweep across the whole table, with a shake far beyond anything
    // the body model would ever produce.
    for (let i = 0; i < 900; i++) {
      const yaw = -1 + (2 * i) / 900;
      const now = 1_000 + i * 16;
      for (const camera of [steady, shaking]) camera.lookAt(yaw, -0.2);
      shaking.setShake({ yaw: noise(), pitch: noise(), roll: noise() });
      steady.update(1 / 60, now);
      shaking.update(1 / 60, now);
    }

    expect(reports.steady.length).toBeGreaterThan(2);
    expect(reports.shaking).toEqual(reports.steady);
  });
});
