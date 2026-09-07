import { describe, expect, it } from 'vitest';
import { Vector3, type Object3D } from 'three';
import { Avatar } from './avatar.js';
import { gazePoint } from './gaze.js';
import { peelContact } from './hold.js';
import { TABLE } from './layout.js';

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


// ---------------------------------------------------------------------------
// Hands
// ---------------------------------------------------------------------------

/** Where a named part of the avatar has ended up in the world. */
function worldOf(avatar: Avatar, object: Object3D): Vector3 {
  avatar.group.updateMatrixWorld(true);
  return object.getWorldPosition(new Vector3());
}

/** The tip of the middle finger of a hand, which is what touches a card. */
function fingertip(avatar: Avatar, hand: 0 | 1): Vector3 {
  const knuckle = avatar.hands[hand]!.fingers[2]!;
  avatar.group.updateMatrixWorld(true);
  // The bone hangs off the knuckle along its own +Z.
  const bone = knuckle.children[0]!;
  return worldOf(avatar, bone);
}

describe('hands on the cards', () => {
  it('leaves both hands on the felt when nobody is touching anything', () => {
    for (const seatIndex of SEATS) {
      const avatar = new Avatar(seatIndex);
      settle(avatar);
      for (const hand of [0, 1] as const) {
        const at = worldOf(avatar, avatar.hands[hand]!.group);
        expect(Math.abs(at.y - TABLE.surfaceHeight)).toBeLessThan(0.1);
      }
    }
  });

  it('reaches the right hand to the corner it is curling', () => {
    for (const seatIndex of SEATS) {
      const avatar = new Avatar(seatIndex);
      avatar.setPeek(1, 0);
      settle(avatar);

      const contact = peelContact(seatIndex, 1, 0);
      const tip = fingertip(avatar, 0);
      const missed = tip.distanceTo(new Vector3(contact.x, contact.y, contact.z));
      expect(missed, `seat ${seatIndex} missed the card by ${missed.toFixed(3)}m`).toBeLessThan(0.1);
    }
  });

  it('carries the cards up with the hand rather than letting them float', () => {
    for (const seatIndex of SEATS) {
      const avatar = new Avatar(seatIndex);
      avatar.setPeek(1, 1);
      settle(avatar);

      const contact = peelContact(seatIndex, 1, 1);
      const tip = fingertip(avatar, 0);
      const missed = tip.distanceTo(new Vector3(contact.x, contact.y, contact.z));
      expect(missed, `seat ${seatIndex} let its cards float by ${missed.toFixed(3)}m`).toBeLessThan(0.12);
      // And it is genuinely up off the table, not still on the felt.
      expect(tip.y).toBeGreaterThan(TABLE.surfaceHeight + 0.15);
    }
  });

  it('brings the off hand up to shield a raised pair, and not before', () => {
    const avatar = new Avatar(0);
    settle(avatar);
    const resting = worldOf(avatar, avatar.hands[1]!.group).y;

    avatar.setPeek(1, 0);
    settle(avatar);
    expect(worldOf(avatar, avatar.hands[1]!.group).y).toBeCloseTo(resting, 2);

    avatar.setPeek(1, 1);
    settle(avatar);
    expect(worldOf(avatar, avatar.hands[1]!.group).y).toBeGreaterThan(resting + 0.1);
  });

  it('curls the fingers as the corner comes up, and opens them again', () => {
    const avatar = new Avatar(3);
    settle(avatar);
    const open = avatar.hands[0]!.fingers[2]!.rotation.x;

    avatar.setPeek(1, 0);
    settle(avatar);
    expect(avatar.hands[0]!.fingers[2]!.rotation.x).toBeGreaterThan(open + 0.3);

    avatar.setPeek(0, 0);
    settle(avatar);
    expect(avatar.hands[0]!.fingers[2]!.rotation.x).toBeCloseTo(open, 2);
  });

  it('keeps the arm an arm: bones do not stretch to reach', () => {
    const avatar = new Avatar(0);
    const lengths: number[] = [];
    for (const lift of [0, 0.5, 1]) {
      avatar.setPeek(1, lift);
      settle(avatar);
      const wrist = worldOf(avatar, avatar.hands[0]!.group);
      const shoulder = worldOf(avatar, avatar.group);
      lengths.push(wrist.distanceTo(shoulder));
    }
    // Every pose is within what the arm could span; none of them is absurd.
    for (const length of lengths) expect(length).toBeLessThan(1.4);
  });

  it('goes back to the felt when the hand is put down', () => {
    const avatar = new Avatar(2);
    avatar.setPeek(1, 1);
    settle(avatar);
    avatar.setPeek(0, 0);
    settle(avatar);

    const at = worldOf(avatar, avatar.hands[0]!.group);
    expect(Math.abs(at.y - TABLE.surfaceHeight)).toBeLessThan(0.1);
  });
});
