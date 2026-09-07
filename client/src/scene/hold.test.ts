import { describe, expect, it } from 'vitest';
import { HAND_LIFT } from '@cursed/shared';
import { heldCard, holeCardRest, outwardFrom, peelContact, raiseAmount, rightFrom } from './hold.js';
import { RADIUS, TABLE, seatPoint } from './layout.js';

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

describe('where the peeling finger goes', () => {
  it('sits on the near corner of the right-hand card', () => {
    for (const seat of SEATS) {
      const contact = peelContact(seat, 0, 0);
      const card = holeCardRest(seat, 1);
      const out = outwardFrom(seat);

      // Nearer the player than the middle of that card, and to its right.
      const toward = (contact.x - card.x) * out.x + (contact.z - card.z) * out.z;
      expect(toward).toBeGreaterThan(0);
      const across = (contact.x - card.x) * rightFrom(seat).x + (contact.z - card.z) * rightFrom(seat).z;
      expect(across).toBeGreaterThan(0);
      // And close enough to be on the card at all.
      expect(distance(contact, card)).toBeLessThan(0.07);
    }
  });

  it('rises as the corner curls', () => {
    const flat = peelContact(2, 0, 0);
    const curled = peelContact(2, 1, 0);
    expect(curled.y).toBeGreaterThan(flat.y);
  });

  it('goes up with the cards when they leave the table', () => {
    for (const seat of SEATS) {
      const down = peelContact(seat, 1, 0);
      const up = peelContact(seat, 1, 1);
      expect(up.y - down.y).toBeCloseTo(HAND_LIFT.height, 6);
    }
  });

  it('never asks a hand to be under the table', () => {
    for (const seat of SEATS) {
      for (const exposure of [0, 0.5, 1]) {
        for (const lift of [0, 0.5, 1]) {
          expect(peelContact(seat, exposure, lift).y).toBeGreaterThan(TABLE.surfaceHeight);
        }
      }
    }
  });
});
