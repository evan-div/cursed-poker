import { describe, expect, it } from 'vitest';
import { HAND_LIFT } from '@cursed/shared';
import {
  cardBend,
  cardSurfacePoint,
  gripPose,
  heldCard,
  holeCardRest,
  outwardFrom,
  raiseAmount,
  rightFrom,
} from './hold.js';
import { CARD, RADIUS, TABLE, seatPoint } from './layout.js';

/**
 * Where the cards are, and therefore where the hand has to be.
 *
 * These numbers are used twice — once to place the cards and once to place the
 * hand that is holding them — so the thing worth testing is that they agree, and
 * that the hand's target is somewhere a hand could plausibly be: on the near
 * corner of the right-hand card, rising with it, never underneath the table.
 */

const SEATS = [0, 1, 2, 3, 4, 5];

function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe('the seat frame', () => {
  it('points outward away from the middle of the table', () => {
    for (const seat of SEATS) {
      const out = outwardFrom(seat);
      const at = seatPoint(seat, RADIUS.holeCards);
      // The outward direction and the seat's own direction from the centre agree.
      const toSeat = Math.hypot(at.x, at.z);
      expect((at.x * out.x + at.z * out.z) / toSeat).toBeCloseTo(1, 6);
    }
  });

  it('puts the right hand at a right angle to that, and level', () => {
    for (const seat of SEATS) {
      const out = outwardFrom(seat);
      const right = rightFrom(seat);
      expect(out.x * right.x + out.z * right.z).toBeCloseTo(0, 9);
      expect(Math.hypot(right.x, right.z)).toBeCloseTo(1, 9);
      expect(right.y).toBe(0);
    }
  });
});

describe('cards on the felt', () => {
  it('lays the pair side by side across the player', () => {
    for (const seat of SEATS) {
      const left = holeCardRest(seat, 0);
      const rightCard = holeCardRest(seat, 1);
      expect(distance(left, rightCard)).toBeGreaterThan(0.06);
      expect(left.y).toBeCloseTo(rightCard.y, 9);
      expect(left.y).toBeGreaterThan(TABLE.surfaceHeight);
    }
  });

  it('does not move them at all until they are picked up', () => {
    for (const seat of SEATS) {
      for (const cardIndex of [0, 1]) {
        const rest = holeCardRest(seat, cardIndex);
        const held = heldCard(seat, cardIndex, 0);
        expect(held.position).toEqual(rest);
        expect(held.tilt).toBeCloseTo(-Math.PI / 2, 9);
        expect(held.roll).toBeCloseTo(0, 9);
      }
    }
  });
});

describe('picking them up', () => {
  it('raises them, brings them back toward their owner and tips them up', () => {
    for (const seat of SEATS) {
      const rest = holeCardRest(seat, 1);
      const held = heldCard(seat, 1, 1);

      expect(held.position.y - rest.y).toBeCloseTo(HAND_LIFT.height, 6);
      expect(distance(held.position, rest)).toBeCloseTo(HAND_LIFT.reach, 6);
      // Further from the middle of the table than they were: toward the player.
      expect(Math.hypot(held.position.x, held.position.z)).toBeGreaterThan(
        Math.hypot(rest.x, rest.z),
      );
      expect(held.tilt).toBeLessThan(-Math.PI / 2);
    }
  });

  it('fans the two cards apart', () => {
    const left = heldCard(0, 0, 1);
    const right = heldCard(0, 1, 1);
    expect(Math.sign(left.roll)).not.toBe(Math.sign(right.roll));
  });

  it('comes off the table with weight rather than snapping up', () => {
    expect(raiseAmount(0)).toBe(0);
    expect(raiseAmount(1)).toBe(1);
    expect(raiseAmount(0.1)).toBeLessThan(0.1);
    expect(raiseAmount(0.9)).toBeGreaterThan(0.9);
    expect(raiseAmount(5)).toBe(1);
    expect(raiseAmount(Number.NaN)).toBe(0);
  });
});

describe('where the peeling hand goes', () => {
  it('sits on the near corner of the right-hand card', () => {
    for (const seat of SEATS) {
      const grip = gripPose(seat, 0, 0).at;
      const card = holeCardRest(seat, 1);
      const out = outwardFrom(seat);

      // Nearer the player than the middle of that card, and to its right.
      const toward = (grip.x - card.x) * out.x + (grip.z - card.z) * out.z;
      expect(toward).toBeGreaterThan(0);
      const across =
        (grip.x - card.x) * rightFrom(seat).x + (grip.z - card.z) * rightFrom(seat).z;
      expect(across).toBeGreaterThan(0);
      // And close enough to be on the card at all.
      expect(distance(grip, card)).toBeLessThan(0.07);
    }
  });

  it('rides the corner up as it curls', () => {
    const flat = gripPose(2, 0, 0).at;
    const curled = gripPose(2, 1, 0).at;
    expect(curled.y).toBeGreaterThan(flat.y);
  });

  it('never asks a hand to be under the table', () => {
    for (const seat of SEATS) {
      for (const exposure of [0, 0.5, 1]) {
        for (const lift of [0, 0.25, 0.5, 0.75, 1]) {
          expect(gripPose(seat, exposure, lift).at.y).toBeGreaterThan(TABLE.surfaceHeight);
        }
      }
    }
  });
});

describe('holding a raised pair', () => {
  it('takes hold of the low edge, not the middle', () => {
    for (const seat of SEATS) {
      const grip = gripPose(seat, 1, 1).at;
      const middle = heldCard(seat, 1, 1).position;
      // Below the middle of the cards by most of a half-card.
      expect(middle.y - grip.y).toBeGreaterThan(CARD.height * 0.3);
    }
  });

  it('holds them between the two cards rather than off one side', () => {
    for (const seat of SEATS) {
      const grip = gripPose(seat, 1, 1).at;
      const right = rightFrom(seat);
      const centre = seatPoint(seat, RADIUS.holeCards);
      const across = (grip.x - centre.x) * right.x + (grip.z - centre.z) * right.z;
      expect(Math.abs(across)).toBeLessThan(CARD.width / 2);
    }
  });

  it('points the fingers up along the cards and the knuckles away from them', () => {
    for (const seat of SEATS) {
      const { along, up } = gripPose(seat, 1, 1);
      const out = outwardFrom(seat);

      // The fingers run up out of the grip toward the far edge, which is the
      // top of a raised pair.
      expect(along.y).toBeGreaterThan(0.5);
      // The back of the hand faces the way the cards' backs do: the fingers lie
      // flat behind them and only the thumb comes round onto the printed side.
      // The other way round is four fingers across the faces.
      expect(up.x * out.x + up.z * out.z).toBeLessThan(-0.5);
      // Both are unit, and square to each other, or the hand shears.
      expect(Math.hypot(along.x, along.y, along.z)).toBeCloseTo(1, 6);
      expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 6);
      expect(along.x * up.x + along.y * up.y + along.z * up.z).toBeCloseTo(0, 6);
    }
  });

  it('turns the hand over exactly as far as the cards have come up', () => {
    expect(gripPose(0, 1, 0).raise).toBe(0);
    expect(gripPose(0, 1, 1).raise).toBe(1);
    expect(gripPose(0, 1, 0.5).raise).toBeCloseTo(raiseAmount(0.5), 9);
  });
});

describe('the bend', () => {
  it('curls the near card ahead of the far one', () => {
    expect(cardBend(0, 0.5)).toBeGreaterThan(cardBend(1, 0.5));
  });

  it('lets go of the curl as the cards leave the table', () => {
    const onTheFelt = cardBend(0, 1, 0);
    expect(onTheFelt).toBeGreaterThan(1);
    expect(cardBend(0, 1, 0.5)).toBeLessThan(onTheFelt);
    // Flat in the hand: a card in the air has nothing to bend against.
    expect(cardBend(0, 1, 1)).toBe(0);
    expect(cardBend(1, 1, 1)).toBe(0);
  });
});

describe('points on a card', () => {
  it('leaves the middle of the card exactly where the card is', () => {
    for (const seat of SEATS) {
      for (const lift of [0, 0.5, 1]) {
        const middle = cardSurfacePoint(seat, 1, lift, { x: 0, y: 0, z: 0 });
        const card = heldCard(seat, 1, lift).position;
        expect(distance(middle, card)).toBeCloseTo(0, 9);
        expect(middle.y).toBeCloseTo(card.y, 9);
      }
    }
  });

  it('puts the far edge below the near one once the pair is up', () => {
    for (const seat of SEATS) {
      const near = cardSurfacePoint(seat, 1, 1, { x: 0, y: -CARD.height / 2, z: 0 });
      const far = cardSurfacePoint(seat, 1, 1, { x: 0, y: CARD.height / 2, z: 0 });
      expect(near.y).toBeGreaterThan(far.y);
    }
  });

  it('keeps every corner a card away from the middle, at any lift', () => {
    const half = Math.hypot(CARD.width / 2, CARD.height / 2);
    for (const seat of SEATS) {
      for (const lift of [0, 0.3, 1]) {
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            const corner = cardSurfacePoint(seat, 0, lift, {
              x: (sx * CARD.width) / 2,
              y: (sy * CARD.height) / 2,
              z: 0,
            });
            const card = heldCard(seat, 0, lift).position;
            const away = Math.hypot(corner.x - card.x, corner.y - card.y, corner.z - card.z);
            expect(away).toBeCloseTo(half, 6);
          }
        }
      }
    }
  });
});
