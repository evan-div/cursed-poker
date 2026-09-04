import { describe, expect, it } from 'vitest';
import { Object3D, PerspectiveCamera, Vector3 } from 'three';
import { MAX_PLAYERS } from '@cursed/shared';
import {
  CHIP,
  DEALER_STATION,
  RADIUS,
  STATION_COUNT,
  boardCardPosition,
  chipCountFor,
  chipPile,
  facingCentreYaw,
  seatAngle,
  seatStation,
  seatedView,
  stationAngle,
  stationPoint,
} from './layout.js';

/**
 * Asks Three.js itself which way a camera is looking, rather than restating a
 * convention here. An earlier version of these tests encoded the same wrong
 * forward axis as the code and happily agreed with it.
 *
 * It has to be a real camera: `Object3D.getWorldDirection` returns the object's
 * +Z axis, and only `Camera` overrides it to negate that into a view direction.
 */
function lookDirection(yaw: number): Vector3 {
  const camera = new PerspectiveCamera();
  camera.rotation.y = yaw;
  return camera.getWorldDirection(new Vector3());
}

const distance = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

describe('the ring', () => {
  it('seats seven: the Dealer and six players', () => {
    expect(STATION_COUNT).toBe(MAX_PLAYERS + 1);
    expect(DEALER_STATION).toBe(0);
    expect([0, 1, 2, 3, 4, 5].map(seatStation)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('spaces every station evenly and never puts one on the Dealer', () => {
    const angles = Array.from({ length: STATION_COUNT }, (_, i) => stationAngle(i));
    for (let i = 1; i < angles.length; i++) {
      expect(angles[i]! - angles[i - 1]!).toBeCloseTo((Math.PI * 2) / STATION_COUNT, 10);
    }
    for (let seat = 0; seat < MAX_PLAYERS; seat++) {
      expect(seatAngle(seat)).not.toBeCloseTo(stationAngle(DEALER_STATION), 10);
    }
  });

  it('sits the Dealer in the ring, not outside it', () => {
    // He takes a station like everyone else, which means two players are his
    // immediate neighbours. That is deliberate: nobody is safely far away.
    const dealer = stationPoint(DEALER_STATION, RADIUS.body);
    expect(dealer.x).toBeCloseTo(0, 10);
    expect(dealer.z).toBeCloseTo(-RADIUS.body, 10);

    const neighbours = [0, MAX_PLAYERS - 1].map((seat) =>
      Math.hypot(
        stationPoint(seatStation(seat), RADIUS.body).x - dealer.x,
        stationPoint(seatStation(seat), RADIUS.body).z - dealer.z,
      ),
    );
    for (const distance of neighbours) expect(distance).toBeLessThan(1.0);
  });

  it('keeps every station the same distance from the middle', () => {
    for (let station = 0; station < STATION_COUNT; station++) {
      const point = stationPoint(station, RADIUS.body);
      expect(Math.hypot(point.x, point.z)).toBeCloseTo(RADIUS.body, 10);
    }
  });

  it('leaves enough elbow room between neighbours to seat a person', () => {
    for (let station = 0; station < STATION_COUNT; station++) {
      const here = stationPoint(station, RADIUS.body);
      const next = stationPoint((station + 1) % STATION_COUNT, RADIUS.body);
      expect(distance(here, next)).toBeGreaterThan(0.55);
    }
  });
});

describe('the seated camera', () => {
  it('places a player at their own seat, facing the middle', () => {
    for (let seat = 0; seat < MAX_PLAYERS; seat++) {
      const view = seatedView(seat);
      expect(Math.hypot(view.position.x, view.position.z)).toBeCloseTo(RADIUS.eye, 10);

      // The camera's actual look direction must point at the middle of the table.
      const forward = lookDirection(view.yaw);
      const toCentre = new Vector3(-view.position.x, 0, -view.position.z).normalize();
      expect(forward.x).toBeCloseTo(toCentre.x, 6);
      expect(forward.z).toBeCloseTo(toCentre.z, 6);
    }
  });

  it('turns a seated body to face the middle too, with the opposite sign', () => {
    // A body's forward is its own +Z; a camera's is its own -Z. Getting these
    // confused seats four of the six players facing into the dark.
    for (let station = 0; station < STATION_COUNT; station++) {
      const body = new Object3D();
      body.rotation.y = facingCentreYaw(station);
      const forward = body.localToWorld(new Vector3(0, 0, 1)).normalize();

      const seat = stationPoint(station, RADIUS.body);
      const toCentre = new Vector3(-seat.x, 0, -seat.z).normalize();
      expect(forward.x).toBeCloseTo(toCentre.x, 6);
      expect(forward.z).toBeCloseTo(toCentre.z, 6);
    }
  });

  it('gives everyone a different chair', () => {
    const seen = new Set<string>();
    for (let seat = 0; seat < MAX_PLAYERS; seat++) {
      const { position } = seatedView(seat);
      seen.add(`${position.x.toFixed(4)},${position.z.toFixed(4)}`);
    }
    expect(seen.size).toBe(MAX_PLAYERS);
  });

  it('seats a viewer with no chair in the Dealer\'s place', () => {
    const spectator = seatedView(null);
    const dealer = stationPoint(DEALER_STATION, RADIUS.eye, spectator.position.y);
    expect(spectator.position.x).toBeCloseTo(dealer.x, 10);
    expect(spectator.position.z).toBeCloseTo(dealer.z, 10);
  });
});

describe('the board', () => {
  it('lays five cards in a centred row', () => {
    const cards = [0, 1, 2, 3, 4].map(boardCardPosition);
    expect(cards[2]!.x).toBeCloseTo(0, 10);
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i]!.x - cards[i - 1]!.x).toBeCloseTo(cards[1]!.x - cards[0]!.x, 10);
    }
    expect(cards[0]!.x).toBeCloseTo(-cards[4]!.x, 10);
  });
});

describe('chips', () => {
  it('scales the pile with the blinds, not the raw chip count', () => {
    // A hundred big blinds looks the same at every level.
    expect(chipCountFor(10_000, 100)).toBe(chipCountFor(100_000, 1_000));
    expect(chipCountFor(0, 100)).toBe(0);
    expect(chipCountFor(1, 100)).toBe(1); // never vanish entirely
  });

  it('caps the pile so a chip leader cannot flood the table', () => {
    expect(chipCountFor(50_000_000, 100)).toBe(120);
    expect(chipCountFor(50_000_000, 100, 40)).toBe(40);
  });

  it('handles a level with no blinds without dividing by zero', () => {
    expect(chipCountFor(1_000, 0)).toBe(0);
  });

  it('stacks chips upward, then sideways', () => {
    const pile = chipPile(CHIP.perStack + 1);
    expect(pile).toHaveLength(CHIP.perStack + 1);

    const first = pile.slice(0, CHIP.perStack);
    expect(new Set(first.map((c) => c.x.toFixed(6))).size).toBe(1);
    for (let i = 1; i < first.length; i++) {
      expect(first[i]!.y).toBeGreaterThan(first[i - 1]!.y);
    }
    // The chip after a full stack starts a new one beside it, at the bottom.
    expect(pile[CHIP.perStack]!.x).not.toBeCloseTo(first[0]!.x, 6);
    expect(pile[CHIP.perStack]!.y).toBeCloseTo(first[0]!.y, 10);
  });

  it('centres a pile of several stacks on its own position', () => {
    const pile = chipPile(CHIP.perStack * 3);
    const xs = [...new Set(pile.map((c) => c.x))];
    expect(xs).toHaveLength(3);
    expect(xs.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 10);
  });

  it('never sinks a chip into the table', () => {
    for (const chip of chipPile(45)) expect(chip.y).toBeGreaterThan(0);
  });
});
