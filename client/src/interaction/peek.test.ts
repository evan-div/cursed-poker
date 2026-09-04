import { describe, expect, it } from 'vitest';
import { PEEK, quantisePeek } from '@cursed/shared';
import { PeekGesture, liftAngle } from './peek.js';

/**
 * The feel of lifting a card.
 *
 * Worth testing because "it should feel tactile" is otherwise unfalsifiable. The
 * properties that make it tactile are concrete: exposure tracks input rather
 * than snapping to states, a half-pull stays half-pulled, letting go drops the
 * card, and nothing a player can do makes exposure leave 0..1.
 */

describe('lifting a card', () => {
  it('does nothing at all until the player takes hold', () => {
    const peek = new PeekGesture();
    peek.move(500);
    expect(peek.exposure).toBe(0);
    expect(peek.holding).toBe(false);
  });

  it('tracks the pull, proportionally', () => {
    const peek = new PeekGesture({ travelPixels: 100 });
    peek.begin();

    peek.move(25);
    expect(peek.exposure).toBeCloseTo(0.25, 6);
    peek.move(25);
    expect(peek.exposure).toBeCloseTo(0.5, 6);
    // Pushing back down puts it back.
    peek.move(-40);
    expect(peek.exposure).toBeCloseTo(0.1, 6);
  });

  it('stays exactly where it was put for as long as it is held', () => {
    const peek = new PeekGesture({ travelPixels: 100 });
    peek.begin();
    peek.move(40);
    for (let i = 0; i < 100; i++) peek.update(1 / 60);
    expect(peek.exposure).toBeCloseTo(0.4, 6);
  });

  it('cannot be pulled past fully lifted or below the felt', () => {
    const peek = new PeekGesture({ travelPixels: 100 });
    peek.begin();
    peek.move(10_000);
    expect(peek.exposure).toBe(1);
    peek.move(-10_000);
    expect(peek.exposure).toBe(0);
  });

  it('drops when released, and stays down', () => {
    const peek = new PeekGesture({ travelPixels: 100, dropPerSecond: 5 });
    peek.begin();
    peek.move(100);
    peek.release();

    peek.update(0.1);
    expect(peek.exposure).toBeCloseTo(0.5, 6);
    peek.update(0.5);
    expect(peek.exposure).toBe(0);
    peek.update(0.5);
    expect(peek.exposure).toBe(0);
  });

  it('resumes a re-check from where the card already is', () => {
    const peek = new PeekGesture({ travelPixels: 100, dropPerSecond: 5 });
    peek.begin();
    peek.move(60);
    peek.release();
    peek.update(0.01); // barely fallen: 0.60 -> 0.55

    // A second look is a small movement, not a full lift from flat.
    peek.begin();
    peek.move(10);
    expect(peek.exposure).toBeGreaterThan(0.6);
  });

  it('shows a rank only once the card is properly up', () => {
    const peek = new PeekGesture({ travelPixels: 100 });
    peek.begin();
    peek.move(PEEK.rankVisibleAt * 100 - 1);
    expect(peek.rankVisible).toBe(false);
    peek.move(2);
    expect(peek.rankVisible).toBe(true);
  });

  it('makes an unsteady hand work harder for the same look', () => {
    const steady = new PeekGesture({ travelPixels: 100 });
    const shaking = new PeekGesture({ travelPixels: 100, unsteadiness: 1 });
    for (const peek of [steady, shaking]) {
      peek.begin();
      peek.move(60);
    }
    expect(shaking.exposure).toBeLessThan(steady.exposure);
    // But the same pull, continued, still gets all the way there.
    shaking.move(1_000);
    expect(shaking.exposure).toBe(1);
  });

  it('survives nonsense input without leaving 0..1', () => {
    const peek = new PeekGesture({ travelPixels: 100 });
    peek.begin();
    for (const dy of [Number.NaN, Number.POSITIVE_INFINITY, -Number.NaN, 50]) peek.move(dy);
    expect(peek.exposure).toBeGreaterThanOrEqual(0);
    expect(peek.exposure).toBeLessThanOrEqual(1);
    expect(peek.exposure).toBeCloseTo(0.5, 6);
  });

  it('is dropped outright by a reset', () => {
    const peek = new PeekGesture();
    peek.begin();
    peek.move(1_000);
    peek.reset();
    expect(peek.exposure).toBe(0);
    expect(peek.holding).toBe(false);
  });
});

describe('the shape of the lift', () => {
  it('rises from flat to fully open, and never past it', () => {
    expect(liftAngle(0)).toBe(0);
    expect(liftAngle(1)).toBeCloseTo(PEEK.maxLift, 6);
    expect(liftAngle(5)).toBeCloseTo(PEEK.maxLift, 6);
    expect(liftAngle(-5)).toBe(0);
  });

  it('is eased, so a twitch is not a tell', () => {
    // The first tenth of a pull moves the card far less than a tenth of the way.
    expect(liftAngle(0.1)).toBeLessThan(PEEK.maxLift * 0.1);
    expect(liftAngle(0.5)).toBeCloseTo(PEEK.maxLift * 0.5, 6);
  });

  it('never goes backwards as the pull increases', () => {
    let previous = -1;
    for (let e = 0; e <= 1.0001; e += 0.02) {
      const angle = liftAngle(e);
      expect(angle).toBeGreaterThanOrEqual(previous);
      previous = angle;
    }
  });
});

describe('what the table is told', () => {
  it('rounds exposure to something nobody could measure an edge from', () => {
    const seen = new Set<number>();
    for (let e = 0; e <= 1.0001; e += 0.001) seen.add(quantisePeek(e));
    expect(seen.size).toBe(PEEK.quantiseSteps + 1);
  });
});
