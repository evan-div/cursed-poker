import { CanvasTexture, LinearFilter, SRGBColorSpace, type Texture } from 'three';
import { RANK_CHARS } from '@cursed/shared';
import { ATLAS_COLUMNS, ATLAS_ROWS, BACK_CELL, BLANK_CELL, CELL } from './card-atlas.js';
import { isCourt, pipsFor } from './card-pips.js';

/**
 * Paints the card atlas.
 *
 * Drawn once at startup into a single canvas, so the whole table's worth of
 * cards shares one texture and one material. The faces are plain and legible
 * rather than ornate: at the size a card appears across a poker table, anything
 * fussier reads as noise, and the horror in this game is not supposed to come
 * from the cards.
 */

const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'];
const RED_SUITS = new Set([1, 2]);

const FACE = '#e9e3d8';
const INK = '#16110f';
const RED = '#8e1f18';

let cached: Texture | null = null;

export function cardAtlasTexture(): Texture {
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLUMNS * CELL.width;
  canvas.height = ATLAS_ROWS * CELL.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D context for the card atlas');

  ctx.fillStyle = '#00000000';
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 0; rank < 13; rank++) {
      drawFace(ctx, rank * CELL.width, suit * CELL.height, rank, suit);
    }
  }
  drawBack(ctx, BACK_CELL.column * CELL.width, BACK_CELL.row * CELL.height);
  drawBlank(ctx, BLANK_CELL.column * CELL.width, BLANK_CELL.row * CELL.height);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  cached = texture;
  return texture;
}

function roundedCard(ctx: CanvasRenderingContext2D, x: number, y: number, fill: string): void {
  const inset = 5;
  const radius = 14;
  const w = CELL.width - inset * 2;
  const h = CELL.height - inset * 2;
  ctx.beginPath();
  ctx.roundRect(x + inset, y + inset, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
}

function drawFace(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rank: number,
  suit: number,
): void {
  roundedCard(ctx, x, y, FACE);

  const colour = RED_SUITS.has(suit) ? RED : INK;
  const glyph = SUIT_GLYPHS[suit]!;

  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = colour;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  drawIndex(ctx, rank, glyph);
  if (isCourt(rank)) drawCourt(ctx, rank, glyph);
  else drawPips(ctx, rank, glyph);

  ctx.restore();
}

/**
 * The corner index: rank above its suit, top-left, and again upside down at the
 * bottom-right.
 *
 * Two, not four. An earlier version printed all four corners — four-index decks
 * are real, and they made a peeked corner readable whichever one you lifted —
 * but people have been reading this arrangement since they were children and
 * notice instantly when a card is wrong. The peel is aimed at a corner that has
 * an index instead.
 */
function drawIndex(ctx: CanvasRenderingContext2D, rank: number, glyph: string): void {
  const rankChar = RANK_CHARS[rank]!;
  const corner = (cx: number, cy: number, flip: boolean) => {
    ctx.save();
    ctx.translate(CELL.width * cx, CELL.height * cy);
    if (flip) ctx.rotate(Math.PI);
    ctx.font = `bold ${Math.round(CELL.height * 0.17)}px Georgia, serif`;
    ctx.fillText(rankChar, 0, 0);
    ctx.font = `${Math.round(CELL.height * 0.115)}px Georgia, serif`;
    ctx.fillText(glyph, 0, Math.round(CELL.height * 0.125));
    ctx.restore();
  };
  corner(0.14, 0.115, false);
  corner(0.86, 0.885, true);
}

/** The count, in the arrangement a printer would use. See `card-pips.ts`. */
function drawPips(ctx: CanvasRenderingContext2D, rank: number, glyph: string): void {
  // An ace gets one large pip; everything else gets its count at pip size.
  const size = rank === 12 ? CELL.height * 0.34 : CELL.height * 0.155;
  ctx.font = `${Math.round(size)}px Georgia, serif`;

  for (const pip of pipsFor(rank)) {
    ctx.save();
    ctx.translate(CELL.width * pip.x, CELL.height * pip.y);
    if (pip.inverted) ctx.rotate(Math.PI);
    // Glyph metrics sit a shade high; nudged so a column of pips looks even.
    ctx.fillText(glyph, 0, size * 0.04);
    ctx.restore();
  }
}

/**
 * A court card.
 *
 * Deliberately a monogram rather than an attempt at the engraved figures: a
 * procedurally drawn king is a bad king, and at the size a card appears across
 * this table the letter is what anybody reads anyway. Two of them, one either
 * way up, so the card stays symmetrical like the pip ranks.
 */
function drawCourt(ctx: CanvasRenderingContext2D, rank: number, glyph: string): void {
  const rankChar = RANK_CHARS[rank]!;
  const half = (flip: boolean) => {
    ctx.save();
    ctx.translate(CELL.width / 2, CELL.height / 2);
    if (flip) ctx.rotate(Math.PI);
    ctx.font = `bold ${Math.round(CELL.height * 0.2)}px Georgia, serif`;
    ctx.fillText(rankChar, 0, -CELL.height * 0.15);
    ctx.font = `${Math.round(CELL.height * 0.12)}px Georgia, serif`;
    ctx.fillText(glyph, 0, -CELL.height * 0.03);
    ctx.restore();
  };
  half(false);
  half(true);

  // A rule down the middle, the way a court card is mirrored about its waist.
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillRect(CELL.width * 0.2, CELL.height * 0.5 - 1, CELL.width * 0.6, 2);
  ctx.restore();
}

function drawBack(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  roundedCard(ctx, x, y, '#2b1a17');

  // A dim woven pattern; whatever is printed on these cards, nobody chose it.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 12, y + 12, CELL.width - 24, CELL.height - 24);
  ctx.clip();
  ctx.strokeStyle = '#3d2723';
  ctx.lineWidth = 3;
  for (let i = -CELL.height; i < CELL.width + CELL.height; i += 12) {
    ctx.beginPath();
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + CELL.height, y + CELL.height);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = '#5a3b34';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x + 14, y + 14, CELL.width - 28, CELL.height - 28, 8);
  ctx.stroke();
}

function drawBlank(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  // The card edges. A flat off-white so a stack reads as paper, not plastic.
  ctx.fillStyle = '#cfc7b8';
  ctx.fillRect(x, y, CELL.width, CELL.height);
}
