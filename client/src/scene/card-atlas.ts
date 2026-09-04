import { RANK_COUNT, SUIT_COUNT, rankOf, suitOf, type Card } from '@cursed/shared';

/**
 * Card faces, drawn into one texture at runtime.
 *
 * No image files: a canvas atlas means nothing to load, nothing to version, and
 * — the part that matters for performance — one texture and one material for
 * every card on the table, so the board and twelve hole cards cost a handful of
 * draw calls rather than seventeen material switches.
 *
 * The grid is 13 ranks across by 4 suits down, with one extra row holding the
 * card back and a blank cell for the edges.
 */

export const ATLAS_COLUMNS = RANK_COUNT;
export const ATLAS_ROWS = SUIT_COUNT + 1;

/** Cell size in pixels. The ratio matches a real card (63.5mm x 88.9mm). */
export const CELL = { width: 160, height: 224 } as const;

export interface AtlasCell {
  column: number;
  row: number;
}

export const BACK_CELL: AtlasCell = { column: 0, row: SUIT_COUNT };
export const BLANK_CELL: AtlasCell = { column: 1, row: SUIT_COUNT };

export function faceCell(card: Card): AtlasCell {
  return { column: rankOf(card), row: suitOf(card) };
}

export interface UvRect {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

/**
 * The UV rectangle for a cell.
 *
 * Textures are flipped vertically by default in Three.js, so canvas row 0 — the
 * top — is at v = 1. Getting this backwards silently renders every card upside
 * down, which is why it is a pure function with a test rather than a fiddle in
 * the renderer.
 */
export function cellUv(cell: AtlasCell): UvRect {
  return {
    uMin: cell.column / ATLAS_COLUMNS,
    uMax: (cell.column + 1) / ATLAS_COLUMNS,
    vMin: 1 - (cell.row + 1) / ATLAS_ROWS,
    vMax: 1 - cell.row / ATLAS_ROWS,
  };
}

/** Every distinct cell is disjoint from every other. Asserted by the tests. */
export function allCells(): AtlasCell[] {
  const cells: AtlasCell[] = [];
  for (let row = 0; row < SUIT_COUNT; row++) {
    for (let column = 0; column < ATLAS_COLUMNS; column++) cells.push({ column, row });
  }
  cells.push(BACK_CELL, BLANK_CELL);
  return cells;
}
