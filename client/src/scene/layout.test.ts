import { describe, expect, it } from 'vitest';
import { Object3D, PerspectiveCamera, Vector3 } from 'three';
import { MAX_PLAYERS } from '@cursed/shared';
import {
  CHIP,
  DEALER_STATION,
  RADIUS,
  STATION_COUNT,
  CHIP_VALUES,
  boardCardPosition,
  chipBreakdown,
  chipHeap,
  chipStacks,
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
  const worth = (counts: readonly number[]) =>
    counts.reduce((sum, count, i) => sum + count * CHIP_VALUES[i]!, 0);

  it('breaks an amount into chips that add up to it', () => {
    for (const blinds of [0.25, 1, 2.5, 7, 20, 99.75, 100, 137, 300, 1_000]) {
      const counts = chipBreakdown(blinds * 100, 100);
      expect(worth(counts), `${blinds} big blinds`).toBe(blinds * 4);
      for (const count of counts) {
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('scales the pile with the blinds, not the raw chip count', () => {
    // A stack looks the same at every level: 100BB is 100BB.
    expect(chipBreakdown(10_000, 100)).toEqual(chipBreakdown(100_000, 1_000));
    expect(worth(chipBreakdown(0, 100))).toBe(0);
    expect(worth(chipBreakdown(1, 100))).toBe(1); // never vanish entirely
    expect(worth(chipBreakdown(1_000, 0))).toBe(0);
  });

  it('gives a bigger stack more chips, and bigger chips', () => {
    // The pile it replaced was a count capped at ninety, so everybody over
    // twenty big blinds had the same stack. Size has to mean something.
    const total = (blinds: number) => chipBreakdown(blinds * 100, 100).reduce((a, b) => a + b, 0);
    const sizes = [1, 5, 20, 100, 300, 600].map(total);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]!);

    const short = chipBreakdown(1_000, 100);
    const deep = chipBreakdown(60_000, 100);
    expect(short[3]! + short[4]!).toBe(0);
    expect(deep[3]! + deep[4]!).toBeGreaterThan(0);
  });

  it('keeps a stack a person could plausibly sit behind', () => {
    for (const blinds of [100, 600, 5_000, 500_000]) {
      const counts = chipBreakdown(blinds * 100, 100);
      expect(chipStacks(counts).length).toBeLessThanOrEqual(120);
      expect(chipHeap(counts, 60).length).toBeLessThanOrEqual(60);
    }
  });

  it('places every chip it was given, and no more', () => {
    const counts = chipBreakdown(13_700, 100);
    const total = counts.reduce((a, b) => a + b, 0);
    for (const placed of [chipStacks(counts), chipHeap(counts)]) {
      expect(placed).toHaveLength(total);
      for (let d = 0; d < counts.length; d++) {
        expect(placed.filter((chip) => chip.denomination === d)).toHaveLength(counts[d]!);
      }
    }
  });

  it('stacks chips upward, one colour to a stack', () => {
    const placed = chipStacks([0, CHIP.perStack + 1, 0, 0, 0]);
    // Twenty in the first stack, and the twenty-first starts another beside it.
    const firstStack = placed.slice(0, CHIP.perStack);
    for (let i = 1; i < firstStack.length; i++) {
      expect(firstStack[i]!.y - firstStack[i - 1]!.y).toBeCloseTo(CHIP.height, 10);
      expect(Math.abs(firstStack[i]!.x - firstStack[0]!.x)).toBeLessThan(0.002);
    }
    const overflow = placed[CHIP.perStack]!;
    expect(overflow.y).toBeCloseTo(CHIP.height / 2, 10);
    expect(Math.hypot(overflow.x - placed[0]!.x, overflow.z - placed[0]!.z)).toBeGreaterThan(CHIP.radius);
  });

  it('never sinks a chip into the table, or stands two in the same place', () => {
    const counts = chipBreakdown(27_350, 100);
    for (const placed of [chipStacks(counts), chipHeap(counts)]) {
      for (const chip of placed) expect(chip.y).toBeGreaterThan(0);
      const seen = new Set(placed.map((c) => `${c.x.toFixed(4)}:${c.y.toFixed(4)}:${c.z.toFixed(4)}`));
      expect(seen.size).toBe(placed.length);
    }
  });

  it('keeps separate stacks from standing inside each other', () => {
    const placed = chipStacks(chipBreakdown(60_000, 100));
    const bases = placed.filter((chip) => chip.y < CHIP.height);
    for (let i = 0; i < bases.length; i++) {
      for (let j = i + 1; j < bases.length; j++) {
        const apart = Math.hypot(bases[i]!.x - bases[j]!.x, bases[i]!.z - bases[j]!.z);
        expect(apart).toBeGreaterThan(CHIP.radius * 2 - 0.002);
      }
    }
  });

  it('lays the same pile out the same way every time', () => {
    const counts = chipBreakdown(8_400, 100);
    expect(chipHeap(counts)).toEqual(chipHeap(counts));
    expect(chipStacks(counts)).toEqual(chipStacks(counts));
  });
});
