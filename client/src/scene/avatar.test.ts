import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Avatar } from './avatar.js';
import { gazePoint } from './gaze.js';

/**
 * Bodies at the table.
 *
 * The test that matters here is that a head stays on its shoulders. The head
 * group's origin is its pivot, and it used to sit at the avatar's *feet* with
 * the skull positioned a metre and a fifth up inside it — so turning to look at
 * somebody swung the head through a metre-wide arc around the floor and sent it
 * sailing across the room. It looked like a rendering glitch and it was a
 * transform-order mistake, which is the kind that only a screenshot finds.
 */

const SEATS = [0, 1, 2, 3, 4, 5];

function skullPosition(avatar: Avatar): Vector3 {
  avatar.group.updateMatrixWorld(true);
  return avatar.skull.getWorldPosition(new Vector3());
}

/** Runs the easing to completion, so the head reaches where it is aiming. */
function settle(avatar: Avatar): void {
  for (let i = 0; i < 400; i++) avatar.update(1 / 60);
}

describe('a head on a neck', () => {
  it('stays on its shoulders whatever it looks at', () => {
    for (const seatIndex of SEATS) {
      const avatar = new Avatar(seatIndex);
      const rest = skullPosition(avatar);

      for (const target of [
        { kind: 'DEALER' },
        { kind: 'BOARD' },
        { kind: 'POT' },
        { kind: 'OWN_CARDS' },
        { kind: 'OWN_CHIPS' },
        ...SEATS.filter((s) => s !== seatIndex).map((s) => ({ kind: 'SEAT' as const, seatIndex: s })),
      ] as const) {
        avatar.setGaze(target);
        settle(avatar);

        // A head swivels. It does not travel: anything beyond a few centimetres
        // means it is pivoting about the wrong point.
        const moved = skullPosition(avatar).distanceTo(rest);
        expect(moved, `seat ${seatIndex} looking at ${target.kind} moved its head ${moved.toFixed(2)}m`)
          .toBeLessThan(0.12);
      }
    }
  });

  it('keeps the head above the table, not swinging under it', () => {
    const avatar = new Avatar(0);
    for (const target of [{ kind: 'OWN_CARDS' }, { kind: 'DEALER' }] as const) {
      avatar.setGaze(target);
      settle(avatar);
      expect(skullPosition(avatar).y).toBeGreaterThan(1);
    }
  });

  it('turns toward what it is told to look at', () => {
    // Two subjects on opposite sides of a seat turn the head opposite ways.
    const avatar = new Avatar(0);
    avatar.setGaze({ kind: 'SEAT', seatIndex: 1 });
    settle(avatar);
    const oneWay = avatar.headYaw;

    avatar.setGaze({ kind: 'SEAT', seatIndex: 5 });
    settle(avatar);
    expect(Math.sign(avatar.headYaw)).not.toBe(Math.sign(oneWay));
  });

  it('holds still when its owner is looking at nothing', () => {
    // AWAY is most of what a sweeping look passes through. Snapping to a canned
    // pose every time it did was most of why heads used to shake.
    const avatar = new Avatar(2);
    avatar.setGaze({ kind: 'SEAT', seatIndex: 4 });
    settle(avatar);
    const held = avatar.headYaw;

    avatar.setGaze({ kind: 'AWAY' });
    settle(avatar);
    expect(avatar.headYaw).toBeCloseTo(held, 9);
  });

  it('will not crane further than a neck goes', () => {
    for (const seatIndex of SEATS) {
      const avatar = new Avatar(seatIndex);
      for (const other of SEATS) {
        if (other === seatIndex) continue;
        avatar.setGaze({ kind: 'SEAT', seatIndex: other });
        settle(avatar);
        expect(Math.abs(avatar.headYaw)).toBeLessThanOrEqual((72 * Math.PI) / 180 + 1e-9);
      }
    }
  });

  it('aims at a point a head could actually be', () => {
    // Sanity on the other half: the thing a head is aimed *at* is up where a
    // face is, not down at the floor.
    for (const seatIndex of SEATS) {
      const at = gazePoint({ kind: 'SEAT', seatIndex }, 0)!;
      expect(at.y).toBeGreaterThan(1);
    }
  });
});
