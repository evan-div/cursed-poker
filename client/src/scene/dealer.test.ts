import { describe, expect, it } from 'vitest';
import { Box3, Quaternion, Vector3 } from 'three';
import { DEALER, type DealerPresence } from '@cursed/shared';
import { Dealer } from './dealer.js';
import { RADIUS, seatPoint } from './layout.js';

/**
 * How the Dealer is drawn.
 *
 * He decides nothing here — every one of these starts by handing him a
 * `DealerPresence` the server would have sent — so what is worth testing is
 * that the drawing is *faithful*: his head ends up pointing at the seat he was
 * told to watch, he holds still when nothing changes, and the twitch he was
 * told about plays exactly once.
 *
 * The stillness test is the one that matters. It is easy to add a tasteful idle
 * sway to a model and not notice it has thrown away the whole effect.
 */

const T0 = 1_700_000_000_000;

function presence(over: Partial<DealerPresence> = {}): DealerPresence {
  return { gaze: { kind: 'AWAY' }, posture: 'STILL', stillMs: 0, twitchAt: null, ...over };
}

function settle(dealer: Dealer, seconds = 6): void {
  for (let i = 0; i < seconds * 60; i++) dealer.update(1 / 60);
  dealer.group.updateMatrixWorld(true);
}

/** Where his head is actually pointing, in world space. */
function facing(dealer: Dealer): Vector3 {
  dealer.group.updateMatrixWorld(true);
  // A head's forward is its own +Z, the opposite convention to a camera's.
  return new Vector3(0, 0, 1).applyQuaternion(dealer.head.getWorldQuaternion(new Quaternion()));
}

function headAt(dealer: Dealer): Vector3 {
  dealer.group.updateMatrixWorld(true);
  return dealer.head.getWorldPosition(new Vector3());
}

describe('where he looks', () => {
  it('turns his head toward the seat he was told to watch', () => {
    for (const seatIndex of [0, 1, 2, 3, 4, 5]) {
      const dealer = new Dealer();
      dealer.apply(presence({ gaze: { kind: 'SEAT', seatIndex }, posture: 'WATCHING' }), 0, T0);
      settle(dealer, 10);

      const head = headAt(dealer);
      const toSeat = seatPoint(seatIndex, RADIUS.body, 1.21);
      const wanted = new Vector3(toSeat.x - head.x, 0, toSeat.z - head.z).normalize();
      const looking = facing(dealer).setY(0).normalize();

      const off = (Math.acos(Math.min(1, looking.dot(wanted))) * 180) / Math.PI;
      expect(off, `seat ${seatIndex} was ${off.toFixed(1)}° off`).toBeLessThan(12);
    }
  });

  it('keeps looking wherever he last looked when told AWAY', () => {
    const dealer = new Dealer();
    dealer.apply(presence({ gaze: { kind: 'SEAT', seatIndex: 4 } }), 0, T0);
    settle(dealer, 10);
    const before = facing(dealer);

    dealer.apply(presence({ gaze: { kind: 'AWAY' } }), 0, T0 + 1000);
    settle(dealer, 4);
    // A head that snapped back to centre every time the target cleared would be
    // half of why heads used to crank about. Nothing is a place to keep looking.
    expect(facing(dealer).dot(before)).toBeGreaterThan(0.99);
  });

  it('never has to compromise on a seat, however far round it is', () => {
    // His neck limits are deliberately wider than a player's, and the point is
    // that they never bite: he arrives at the exact bearing to the seat he was
    // told to watch, including the two beside him, which sit sixty degrees off
    // his own forward. (Nothing at this table needs the full range his limits
    // allow — that is for when he can move, which is not yet.)
    const dealer = new Dealer();
    dealer.apply(presence({ gaze: { kind: 'SEAT', seatIndex: 0 } }), 0, T0);
    settle(dealer, 14);

    const head = headAt(dealer);
    const seat = seatPoint(0, RADIUS.body, 1.21);
    const bearing = Math.atan2(seat.x - head.x, seat.z - head.z);
    expect(Math.abs(bearing)).toBeGreaterThan((55 * Math.PI) / 180);
    expect(dealer.head.rotation.y).toBeCloseTo(bearing, 2);
  });

  it('takes its time getting there', () => {
    const dealer = new Dealer();
    dealer.apply(presence({ gaze: { kind: 'SEAT', seatIndex: 3 } }), 0, T0);
    // An eighth of a second in, he is barely under way. The arriving is the
    // unnerving part, so it is not allowed to be instant.
    for (let i = 0; i < 8; i++) dealer.update(1 / 60);
    const early = Math.abs(dealer.head.rotation.y);
    settle(dealer, 12);
    expect(early).toBeLessThan(Math.abs(dealer.head.rotation.y) * 0.5);
  });
});

describe('how still he is', () => {
  it('does not move at all when nothing has changed', () => {
    const dealer = new Dealer();
    dealer.apply(presence({ gaze: { kind: 'SEAT', seatIndex: 1 }, posture: 'WATCHING' }), 0, T0);
    settle(dealer, 12);

    const before = new Box3().setFromObject(dealer.group).clone();
    // A full minute of frames with no new presence at all.
    for (let i = 0; i < 60 * 60; i++) dealer.update(1 / 60);
    dealer.group.updateMatrixWorld(true);
    const after = new Box3().setFromObject(dealer.group);

    // Not "moves a little" — does not move. Players breathe in Phase 6; he
    // never will, and any idle added here would quietly delete the effect.
    expect(after.min.distanceTo(before.min)).toBeLessThan(1e-6);
    expect(after.max.distanceTo(before.max)).toBeLessThan(1e-6);
  });
});

describe('the twitch', () => {
  it('plays a fresh one, once', () => {
    const dealer = new Dealer();
    dealer.apply(presence({ gaze: { kind: 'SEAT', seatIndex: 1 } }), 0, T0);
    settle(dealer, 10);
    const resting = dealer.head.rotation.y;

    dealer.apply(presence({ gaze: { kind: 'SEAT', seatIndex: 1 }, twitchAt: T0 }), 0, T0 + 40);
    dealer.update(1 / 60);
    expect(Math.abs(dealer.head.rotation.y - resting)).toBeGreaterThan(0.05);

    // It is over quickly, and it does not come back.
    settle(dealer, 2);
    const after = dealer.head.rotation.y;
    for (let i = 0; i < 20; i++) {
      // The same timestamp arriving again is the same twitch, not a new one.
      dealer.apply(presence({ gaze: { kind: 'SEAT', seatIndex: 1 }, twitchAt: T0 }), 0, T0 + 200);
      dealer.update(1 / 60);
    }
    expect(Math.abs(dealer.head.rotation.y - after)).toBeLessThan(1e-9);
  });

  it('drops one that happened while nobody was watching', () => {
    // A client joining an hour in is told about his last twitch. It is an hour
    // old. Playing it would make him jerk for something long over.
    const dealer = new Dealer();
    dealer.apply(presence({ gaze: { kind: 'SEAT', seatIndex: 1 } }), 0, T0);
    settle(dealer, 10);
    const resting = dealer.head.rotation.y;

    const stale = T0 - DEALER.twitchFreshMs - 1;
    dealer.apply(presence({ gaze: { kind: 'SEAT', seatIndex: 1 }, twitchAt: stale }), 0, T0);
    dealer.update(1 / 60);
    expect(Math.abs(dealer.head.rotation.y - resting)).toBeLessThan(1e-9);
  });
});

describe('his postures', () => {
  const top = (dealer: Dealer) => new Box3().setFromObject(dealer.group).max.y;

  it('grows out of the floor when he stands, rather than leaving it', () => {
    const still = new Dealer();
    still.apply(presence({ posture: 'STILL' }), 0, T0);
    settle(still);

    const risen = new Dealer();
    risen.apply(presence({ posture: 'RISEN' }), 1, T0);
    settle(risen, 10);

    expect(top(risen)).toBeGreaterThan(top(still) + 0.2);
    // The hem stays on the floor. He has no legs to stand on; the column
    // simply becomes taller, which is worse.
    const floor = new Box3().setFromObject(risen.group).min.y;
    expect(Math.abs(floor)).toBeLessThan(0.02);
  });

  it('bends over the felt when he leans', () => {
    const watching = new Dealer();
    watching.apply(presence({ gaze: { kind: 'SEAT', seatIndex: 1 }, posture: 'WATCHING' }), 0, T0);
    settle(watching, 10);

    const leaning = new Dealer();
    leaning.apply(presence({ gaze: { kind: 'SEAT', seatIndex: 1 }, posture: 'LEANING' }), 0.9, T0);
    settle(leaning, 10);

    // Lower, and further out over the table than he was.
    expect(headAt(leaning).y).toBeLessThan(headAt(watching).y - 0.05);
    expect(headAt(leaning).z).toBeGreaterThan(headAt(watching).z);
  });

  it('only moves its hands while there is something to deal', () => {
    // Measured at a hand rather than at the whole silhouette: his arms live
    // inside the robe's footprint, so swinging them does not move the box
    // around him at all, and a test that watched the box would pass whatever
    // the arms did.
    const handAt = (dealer: Dealer) => {
      dealer.group.updateMatrixWorld(true);
      return dealer.hands[0]!.group.getWorldPosition(new Vector3());
    };

    const idle = new Dealer();
    idle.apply(presence({ posture: 'STILL' }), 0, T0);
    settle(idle, 4);
    const still = handAt(idle);
    for (let i = 0; i < 200; i++) idle.update(1 / 60);
    expect(handAt(idle).distanceTo(still)).toBeLessThan(1e-6);

    const working = new Dealer();
    working.apply(presence({ posture: 'DEALING' }), 0, T0);
    settle(working, 3);
    let travelled = 0;
    let previous = handAt(working);
    for (let i = 0; i < 90; i++) {
      working.update(1 / 60);
      const now = handAt(working);
      travelled += now.distanceTo(previous);
      previous = now;
    }
    // Centimetres of hand, over a second and a half of dealing.
    expect(travelled).toBeGreaterThan(0.02);
  });
});

describe('the lights in the hood', () => {
  it('burn harder as the room turns', () => {
    const glow = (dread: number) => {
      const dealer = new Dealer();
      dealer.apply(presence(), dread, T0);
      settle(dealer, 2);
      return dealer.eyes[0]!.material.emissiveIntensity;
    };
    expect(glow(1)).toBeGreaterThan(glow(0) * 2);
  });

  it('gives each eye its own material, so nothing else in the room follows', () => {
    const dealer = new Dealer();
    expect(dealer.eyes).toHaveLength(2);
    // Sharing the palette's material would turn every emissive thing at the
    // table up with him — the cards included.
    expect(dealer.eyes[0]!.material).not.toBe(dealer.eyes[1]!.material);
  });
});
