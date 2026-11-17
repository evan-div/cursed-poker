import { describe, expect, it } from 'vitest';
import { RANK_CHARS } from '@cursed/shared';
import { isCourt, pipsFor } from './card-pips.js';

/**
 * Card faces.
 *
 * An earlier version printed the rank in all four corners, which made a peeked
 * corner readable whichever one you lifted — and did not look like a playing
 * card, which people notice immediately because they have been reading these
 * arrangements since they were children. These tests hold the standard layout
 * in place: the right number of pips, in two columns, with the bottom half
 * printed upside down.
 */

describe('pip layouts', () => {
  it('prints as many pips as the card is worth', () => {
    // Two through ten, by their 0-based rank.
    for (let rank = 0; rank <= 8; rank++) {
      expect(pipsFor(rank), `${RANK_CHARS[rank]} has the wrong pip count`).toHaveLength(rank + 2);
    }
    expect(pipsFor(12)).toHaveLength(1); // the ace, one large pip
  });

  it('gives the court cards a figure instead', () => {
    for (const rank of [9, 10, 11]) {
      expect(isCourt(rank)).toBe(true);
      expect(pipsFor(rank)).toHaveLength(0);
    }
    for (const rank of [0, 8, 12]) expect(isCourt(rank)).toBe(false);
  });

  it('prints the bottom half upside down, as a real card does', () => {
    for (let rank = 0; rank <= 8; rank++) {
      for (const pip of pipsFor(rank)) {
        expect(pip.inverted, `${RANK_CHARS[rank]} pip at y=${pip.y}`).toBe(pip.y > 0.5);
      }
    }
  });

  it('is symmetrical about the middle, so the card reads either way up', () => {
    // Except the seven, which is famously not: its odd pip sits between the top
    // pair with nothing below to match it. That is what a real seven looks like,
    // and "fixing" it would make the card wrong.
    for (let rank = 0; rank <= 8; rank++) {
      if (rank === 5) continue;
      const pips = pipsFor(rank);
      for (const pip of pips) {
        const mirrored = pips.some(
          (other) => Math.abs(other.x - (1 - pip.x)) < 1e-6 && Math.abs(other.y - (1 - pip.y)) < 1e-6,
        );
        expect(mirrored, `${RANK_CHARS[rank]} has no mirror for (${pip.x}, ${pip.y})`).toBe(true);
      }
    }
  });

  it('keeps every pip on the card, clear of the corner indices', () => {
    for (let rank = 0; rank <= 12; rank++) {
      for (const pip of pipsFor(rank)) {
        expect(pip.x).toBeGreaterThan(0.15);
        expect(pip.x).toBeLessThan(0.85);
        expect(pip.y).toBeGreaterThan(0.12);
        expect(pip.y).toBeLessThan(0.88);
      }
    }
  });

  it('lays the pips out in columns rather than scattering them', () => {
    for (let rank = 2; rank <= 8; rank++) {
      const columns = new Set(pipsFor(rank).map((pip) => pip.x.toFixed(3)));
      expect(columns.size).toBeLessThanOrEqual(3);
    }
  });

  it('gives the seven its odd unmatched pip', () => {
    const seven = pipsFor(5);
    const odd = seven.filter((pip) => pip.x === 0.5);
    expect(odd).toHaveLength(1);
    expect(odd[0]!.y).toBeLessThan(0.5);
    expect(odd[0]!.inverted).toBe(false);
  });

  it('never puts two pips in the same place', () => {
    for (let rank = 0; rank <= 12; rank++) {
      const seen = new Set(pipsFor(rank).map((pip) => `${pip.x},${pip.y}`));
      expect(seen.size).toBe(pipsFor(rank).length);
    }
  });
});
