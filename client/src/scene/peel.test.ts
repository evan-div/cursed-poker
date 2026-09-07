import { describe, expect, it } from 'vitest';
import { PEEK } from '@cursed/shared';
import { CARD } from './layout.js';
import { CORNER_LEAD, PEEL_SPAN, nearEdgeAngle, peelAngle, peelPoint } from './peel.js';

/**
 * Bending a card off the felt.
 *
 * The properties here are the difference between a peek and a card trick. The
 * far edge must never leave the table — a card standing up off the felt is a
 * player showing the room they have something. The near edge must come *past*
 * vertical, or the underside where the face is printed never turns far enough
 * for its owner to read it. And one corner has to lead, or it is a drawbridge
 * rather than a fingertip.
 */

const HALF = CARD.height / 2;
const NEAR = -HALF;
const LEAD_X = CARD.width / 2;
const TRAIL_X = -CARD.width / 2;

/** The card's mid-line, sampled from the far edge to the near one. */
function profile(bend: number, x = LEAD_X, samples = 40) {
  return Array.from({ length: samples + 1 }, (_, i) => {
    const y = HALF - (i / samples) * CARD.height;
    return peelPoint(x, y, 0, bend);
  });
}

describe('a card lying flat', () => {
  it('does not move at all when nobody is touching it', () => {
    for (const point of profile(0)) {
      expect(point.z).toBe(0);
    }
    expect(peelPoint(0, NEAR, 0, 0)).toEqual({ y: NEAR, z: 0 });
  });

  it('ignores a bend too small to see', () => {
    expect(peelPoint(LEAD_X, NEAR, 0, 1e-9).z).toBe(0);
  });
});

describe('the far edge stays on the table', () => {
  it('never lifts the far portion, at any bend', () => {
    const hinge = -HALF + PEEL_SPAN * CARD.height;
    for (const bend of [0.2, 0.8, 1.4, PEEK.maxLift]) {
      for (const x of [TRAIL_X, 0, LEAD_X]) {
        for (let y = hinge; y <= HALF; y += CARD.height / 40) {
          const point = peelPoint(x, y, 0, bend);
          expect(point.z, `bend ${bend} lifted the far half at y=${y.toFixed(4)}`).toBe(0);
          expect(point.y).toBe(y);
        }
      }
    }
  });

  it('keeps the card in contact with the felt at full peel', () => {
    const lowest = Math.min(...profile(PEEK.maxLift).map((p) => p.z));
    expect(lowest).toBe(0);
  });
});

describe('the near edge comes up', () => {
  it('rises further the harder the card is bent', () => {
    let previous = -1;
    for (const bend of [0, 0.3, 0.6, 1.0, 1.4, 1.8, PEEK.maxLift]) {
      const height = peelPoint(LEAD_X, NEAR, 0, bend).z;
      expect(height).toBeGreaterThanOrEqual(previous);
      previous = height;
    }
    expect(previous).toBeGreaterThan(0.02); // a couple of centimetres of card
  });

  it('turns the underside past vertical, so its owner can read it', () => {
    // Below a right angle the printed face still points at the felt.
    expect(nearEdgeAngle(1)).toBeGreaterThan(Math.PI / 2);
  });

  it('draws a curve rather than a crease', () => {
    // A crease is all the bending at one point and a flat flap after it; a bend
    // spreads it evenly. So the test is that the curled part keeps its length:
    // equal steps along the card stay equal steps along the curve.
    const points = profile(PEEK.maxLift).filter((p, i, all) => i === 0 || p.z > 0 || all[i - 1]!.z > 0);
    expect(points.length).toBeGreaterThan(8);

    const steps = points
      .slice(1)
      .map((p, i) => Math.hypot(p.y - points[i]!.y, p.z - points[i]!.z))
      .slice(1); // the first step straddles the hinge

    const longest = Math.max(...steps);
    const shortest = Math.min(...steps);
    expect(longest - shortest).toBeLessThan(longest * 0.02);
  });

  it('pulls the near edge toward the hinge as it curls, never past it', () => {
    const hinge = -HALF + PEEL_SPAN * CARD.height;
    for (const bend of [0.5, 1.2, PEEK.maxLift]) {
      const tip = peelPoint(LEAD_X, NEAR, 0, bend);
      expect(tip.y).toBeGreaterThan(NEAR);
      expect(tip.y).toBeLessThanOrEqual(hinge + 1e-9);
    }
  });
});

describe('one corner leads', () => {
  it('curls the leading corner further than the trailing one', () => {
    const lead = peelPoint(LEAD_X, NEAR, 0, PEEK.maxLift).z;
    const trail = peelPoint(TRAIL_X, NEAR, 0, PEEK.maxLift).z;
    expect(lead).toBeGreaterThan(trail);
    // But the trailing corner still moves — this is a diagonal fold, not a
    // triangle torn off the side.
    expect(trail).toBeGreaterThan(0);
    expect(CORNER_LEAD).toBeGreaterThan(0);
  });

  it('runs the fold smoothly across the card', () => {
    let previous = -1;
    for (let x = TRAIL_X; x <= LEAD_X; x += CARD.width / 20) {
      const height = peelPoint(x, NEAR, 0, PEEK.maxLift).z;
      expect(height).toBeGreaterThanOrEqual(previous);
      previous = height;
    }
  });
});

describe('the shape of the pull', () => {
  it('is eased, so a twitch is not a tell', () => {
    expect(peelAngle(0)).toBe(0);
    expect(peelAngle(0.1)).toBeLessThan(PEEK.maxLift * 0.1);
    expect(peelAngle(1)).toBeCloseTo(PEEK.maxLift, 9);
  });

  it('clamps whatever it is given', () => {
    expect(peelAngle(5)).toBeCloseTo(PEEK.maxLift, 9);
    expect(peelAngle(-5)).toBe(0);
    expect(peelAngle(Number.NaN)).toBe(0);
  });
});
