import { describe, expect, it } from 'vitest';
import { DECK_SIZE, cardFromString, rankOf, suitOf } from '@cursed/shared';
import {
  ATLAS_COLUMNS,
  ATLAS_ROWS,
  BACK_CELL,
  BLANK_CELL,
  allCells,
  cellUv,
  faceCell,
} from './card-atlas.js';

describe('the card atlas', () => {
  it('gives every card in the deck its own cell', () => {
    const seen = new Set<string>();
    for (let card = 0; card < DECK_SIZE; card++) {
      const cell = faceCell(card);
      expect(cell.column).toBeGreaterThanOrEqual(0);
      expect(cell.column).toBeLessThan(ATLAS_COLUMNS);
      expect(cell.row).toBeGreaterThanOrEqual(0);
      expect(cell.row).toBeLessThan(ATLAS_ROWS);
      seen.add(`${cell.column},${cell.row}`);
    }
    expect(seen.size).toBe(DECK_SIZE);
  });

  it('keeps the back and the blank clear of every card face', () => {
    const faces = new Set<string>();
    for (let card = 0; card < DECK_SIZE; card++) {
      const cell = faceCell(card);
      faces.add(`${cell.column},${cell.row}`);
    }
    expect(faces.has(`${BACK_CELL.column},${BACK_CELL.row}`)).toBe(false);
    expect(faces.has(`${BLANK_CELL.column},${BLANK_CELL.row}`)).toBe(false);
    expect(allCells()).toHaveLength(DECK_SIZE + 2);
  });

  it('lays ranks across and suits down', () => {
    const ace = cardFromString('As');
    const deuce = cardFromString('2s');
    expect(faceCell(ace).row).toBe(faceCell(deuce).row);
    expect(faceCell(ace).column).toBeGreaterThan(faceCell(deuce).column);

    const aceOfClubs = cardFromString('Ac');
    expect(faceCell(ace).column).toBe(faceCell(aceOfClubs).column);
    expect(faceCell(ace).row).not.toBe(faceCell(aceOfClubs).row);
  });

  it('maps the top canvas row to the top of the texture', () => {
    // Three.js flips textures, so row 0 must land at the high end of v.
    const top = cellUv({ column: 0, row: 0 });
    const below = cellUv({ column: 0, row: 1 });
    expect(top.vMax).toBeCloseTo(1, 10);
    expect(top.vMin).toBeGreaterThan(below.vMax - 1e-9);
    expect(below.vMax).toBeCloseTo(top.vMin, 10);
  });

  it('produces rectangles inside the texture that never overlap', () => {
    const rects = allCells().map(cellUv);
    for (const rect of rects) {
      expect(rect.uMin).toBeGreaterThanOrEqual(0);
      expect(rect.uMax).toBeLessThanOrEqual(1);
      expect(rect.vMin).toBeGreaterThanOrEqual(0);
      expect(rect.vMax).toBeLessThanOrEqual(1);
      expect(rect.uMax).toBeGreaterThan(rect.uMin);
      expect(rect.vMax).toBeGreaterThan(rect.vMin);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlaps =
          a.uMin < b.uMax - 1e-9 &&
          b.uMin < a.uMax - 1e-9 &&
          a.vMin < b.vMax - 1e-9 &&
          b.vMin < a.vMax - 1e-9;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('agrees with the shared card encoding', () => {
    for (const text of ['As', '2c', 'Td', '7h', 'Kc']) {
      const card = cardFromString(text);
      expect(faceCell(card)).toEqual({ column: rankOf(card), row: suitOf(card) });
    }
  });
});
