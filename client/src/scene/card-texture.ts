import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, type Texture } from 'three';
import { RANK_CHARS } from '@cursed/shared';
import { ATLAS_COLUMNS, ATLAS_ROWS, BACK_CELL, BLANK_CELL, CELL } from './card-atlas.js';
import { isCourt, pipsFor } from './card-pips.js';
import { seeded } from './noise.js';

/**
 * Paints the card atlas.
 *
 * Drawn once at start-up into a single canvas, so the whole table's worth of
 * cards shares one texture and one material. The faces are plain and legible
 * before they are anything else: a card is read across a dark table, at an
 * angle, from a corner, and anything that makes the index harder to find is a
 * worse card however handsome it is.
 *
 * Inside that constraint they are now *cards* rather than labels. The suits are
 * drawn as shapes instead of typed as characters, so they are the same on every
 * machine and stay sharp at any size. The court cards have figures — mirrored
 * about the waist, as court cards are, and with nothing where their eyes should
 * be. The stock has aged. The back is a pattern somebody chose, and it reads
 * the same either way up, which a back has to.
 *
 * Every cell is painted on a transparent ground with its corners rounded; the
 * card material cuts along that edge, so a card on the felt has the corners a
 * card has.
 */

const RED_SUITS = new Set([1, 2]);

const STOCK = '#e6dcc6';
const STOCK_EDGE = '#cfc3a6';
const INK = '#15100e';
const RED = '#8a1a14';
const BACK = '#3a0f10';
const BACK_DEEP = '#200809';
const BACK_LINE = '#8a5a3c';

/** How far in from the cell's edge the card itself starts, and how round it is. */
const INSET = Math.round(CELL.width * 0.03);
const CORNER = Math.round(CELL.width * 0.085);

let cached: Texture | null = null;

export function cardAtlasTexture(): Texture {
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLUMNS * CELL.width;
  canvas.height = ATLAS_ROWS * CELL.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D context for the card atlas');

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const random = seeded(52);
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 0; rank < 13; rank++) {
      drawFace(ctx, rank * CELL.width, suit * CELL.height, rank, suit, random);
    }
  }
  drawBack(ctx, BACK_CELL.column * CELL.width, BACK_CELL.row * CELL.height);
  drawBlank(ctx, BLANK_CELL.column * CELL.width, BLANK_CELL.row * CELL.height);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // Mipmapped: the board is five cards a metre away, each a few dozen pixels
  // across, and without smaller copies to draw from they shimmered as the
  // camera breathed and their pips smeared into grey.
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 8;
  cached = texture;
  return texture;
}

/** The outline of the card inside a cell, as the current path. */
function cardPath(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath();
  ctx.roundRect(x + INSET, y + INSET, CELL.width - INSET * 2, CELL.height - INSET * 2, CORNER);
}

/** Card stock: off-white, darker toward the edges, with a few years on it. */
function paintStock(ctx: CanvasRenderingContext2D, x: number, y: number, random: () => number): void {
  ctx.save();
  cardPath(ctx, x, y);
  ctx.clip();

  const cx = x + CELL.width / 2;
  const cy = y + CELL.height / 2;
  const shade = ctx.createRadialGradient(cx, cy, CELL.width * 0.2, cx, cy, CELL.height * 0.66);
  shade.addColorStop(0, STOCK);
  shade.addColorStop(1, STOCK_EDGE);
  ctx.fillStyle = shade;
  ctx.fillRect(x, y, CELL.width, CELL.height);

  // Foxing: the small brown spots old paper gets. Different on every card,
  // which is also the only thing that tells two cards' faces apart — and they
  // are faces, so that tells nobody anything.
  for (let spot = 0; spot < 9; spot++) {
    const px = x + random() * CELL.width;
    const py = y + random() * CELL.height;
    const size = 0.6 + random() * 1.8;
    ctx.fillStyle = `rgba(120, 84, 48, ${0.05 + random() * 0.1})`;
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * A suit, as a shape centred on the origin and `size` tall.
 *
 * Drawn rather than typed: a font's idea of a spade differs between machines,
 * and on some of them the four suits are not even the same size.
 */
export function suitPath(ctx: CanvasRenderingContext2D, suit: number, size: number): void {
  const s = size / 2;
  ctx.beginPath();
  switch (suit) {
    case 1: // diamonds
      ctx.moveTo(0, -s);
      ctx.bezierCurveTo(s * 0.28, -s * 0.5, s * 0.5, -s * 0.2, s * 0.74, 0);
      ctx.bezierCurveTo(s * 0.5, s * 0.2, s * 0.28, s * 0.5, 0, s);
      ctx.bezierCurveTo(-s * 0.28, s * 0.5, -s * 0.5, s * 0.2, -s * 0.74, 0);
      ctx.bezierCurveTo(-s * 0.5, -s * 0.2, -s * 0.28, -s * 0.5, 0, -s);
      break;
    case 2: // hearts
      ctx.moveTo(0, s);
      ctx.bezierCurveTo(-s * 0.3, s * 0.55, -s * 0.98, s * 0.1, -s * 0.98, -s * 0.42);
      ctx.bezierCurveTo(-s * 0.98, -s * 1.02, -s * 0.2, -s * 1.1, 0, -s * 0.48);
      ctx.bezierCurveTo(s * 0.2, -s * 1.1, s * 0.98, -s * 1.02, s * 0.98, -s * 0.42);
      ctx.bezierCurveTo(s * 0.98, s * 0.1, s * 0.3, s * 0.55, 0, s);
      break;
    case 3: // spades
      ctx.moveTo(0, -s);
      ctx.bezierCurveTo(s * 0.3, -s * 0.5, s * 0.98, -s * 0.08, s * 0.98, s * 0.36);
      ctx.bezierCurveTo(s * 0.98, s * 0.86, s * 0.34, s * 0.9, s * 0.1, s * 0.5);
      ctx.bezierCurveTo(s * 0.12, s * 0.78, s * 0.22, s * 0.92, s * 0.42, s);
      ctx.lineTo(-s * 0.42, s);
      ctx.bezierCurveTo(-s * 0.22, s * 0.92, -s * 0.12, s * 0.78, -s * 0.1, s * 0.5);
      ctx.bezierCurveTo(-s * 0.34, s * 0.9, -s * 0.98, s * 0.86, -s * 0.98, s * 0.36);
      ctx.bezierCurveTo(-s * 0.98, -s * 0.08, -s * 0.3, -s * 0.5, 0, -s);
      break;
    default: {
      // clubs: three lobes and a foot
      const lobe = s * 0.46;
      ctx.arc(0, -s * 0.52, lobe, 0, Math.PI * 2);
      ctx.moveTo(-s * 0.5 + lobe, s * 0.12);
      ctx.arc(-s * 0.5, s * 0.12, lobe, 0, Math.PI * 2);
      ctx.moveTo(s * 0.5 + lobe, s * 0.12);
      ctx.arc(s * 0.5, s * 0.12, lobe, 0, Math.PI * 2);
      ctx.moveTo(0, -s * 0.1);
      ctx.bezierCurveTo(s * 0.08, s * 0.6, s * 0.2, s * 0.9, s * 0.4, s);
      ctx.lineTo(-s * 0.4, s);
      ctx.bezierCurveTo(-s * 0.2, s * 0.9, -s * 0.08, s * 0.6, 0, -s * 0.1);
      break;
    }
  }
  ctx.closePath();
}

function drawSuit(ctx: CanvasRenderingContext2D, suit: number, size: number): void {
  suitPath(ctx, suit, size);
  ctx.fill();
}

function drawFace(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rank: number,
  suit: number,
  random: () => number,
): void {
  paintStock(ctx, x, y, random);

  ctx.save();
  // Everything that follows stays on the card.
  cardPath(ctx, x, y);
  ctx.clip();
  ctx.translate(x, y);
  ctx.fillStyle = RED_SUITS.has(suit) ? RED : INK;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  drawIndex(ctx, rank, suit);
  if (isCourt(rank)) drawCourt(ctx, rank, suit);
  else drawPips(ctx, rank, suit);

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
function drawIndex(ctx: CanvasRenderingContext2D, rank: number, suit: number): void {
  const rankChar = RANK_CHARS[rank]!;
  const corner = (cx: number, cy: number, flip: boolean) => {
    ctx.save();
    ctx.translate(CELL.width * cx, CELL.height * cy);
    if (flip) ctx.rotate(Math.PI);
    ctx.font = `bold ${Math.round(CELL.height * 0.178)}px Georgia, "Times New Roman", serif`;
    ctx.fillText(rankChar, 0, 0);
    ctx.translate(0, CELL.height * 0.132);
    drawSuit(ctx, suit, CELL.height * 0.1);
    ctx.restore();
  };
  corner(0.145, 0.118, false);
  corner(0.855, 0.882, true);
}

/** The count, in the arrangement a printer would use. See `card-pips.ts`. */
function drawPips(ctx: CanvasRenderingContext2D, rank: number, suit: number): void {
  if (rank === 12) return drawAce(ctx, suit);

  const size = CELL.height * 0.15;
  for (const pip of pipsFor(rank)) {
    ctx.save();
    ctx.translate(CELL.width * pip.x, CELL.height * pip.y);
    if (pip.inverted) ctx.rotate(Math.PI);
    drawSuit(ctx, suit, size);
    ctx.restore();
  }
}

/**
 * An ace: one pip, large, with a second line inside it.
 *
 * The ace of spades is the card a maker signs, and this one's has something
 * looking out of it.
 */
function drawAce(ctx: CanvasRenderingContext2D, suit: number): void {
  const size = CELL.height * 0.36;
  ctx.save();
  ctx.translate(CELL.width / 2, CELL.height / 2);
  drawSuit(ctx, suit, size);

  // An inner line, in the colour of the stock.
  ctx.strokeStyle = STOCK;
  ctx.lineWidth = Math.max(1.5, CELL.width * 0.012);
  ctx.save();
  ctx.scale(0.72, 0.72);
  ctx.translate(0, suit === 3 ? -size * 0.04 : 0);
  suitPath(ctx, suit, size);
  ctx.stroke();
  ctx.restore();

  if (suit === 3) {
    // An eye, lidded, in the belly of the spade.
    const w = size * 0.2;
    ctx.fillStyle = STOCK;
    ctx.beginPath();
    ctx.moveTo(-w, size * 0.1);
    ctx.quadraticCurveTo(0, size * 0.1 - w * 0.9, w, size * 0.1);
    ctx.quadraticCurveTo(0, size * 0.1 + w * 0.9, -w, size * 0.1);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(0, size * 0.1, w * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * A court card: a figure in a frame, mirrored about its waist.
 *
 * Simple on purpose. A procedurally drawn king that tries to be an engraving is
 * a bad engraving; one built from a handful of confident shapes is a playing
 * card. What tells the three apart is what a glance can take in — a crown, a
 * coronet, a cap with a feather — and the big letter beside each of them.
 *
 * None of them has eyes. Where the eyes go there is a bar of ink.
 */
function drawCourt(ctx: CanvasRenderingContext2D, rank: number, suit: number): void {
  const w = CELL.width;
  const h = CELL.height;
  const colour = RED_SUITS.has(suit) ? RED : INK;
  const frame = { left: w * 0.24, top: h * 0.13, width: w * 0.52, height: h * 0.74 };

  // The panel the figure stands in.
  ctx.save();
  ctx.lineWidth = Math.max(1.2, w * 0.009);
  ctx.strokeRect(frame.left, frame.top, frame.width, frame.height);
  ctx.lineWidth = Math.max(0.8, w * 0.005);
  ctx.strokeRect(frame.left + w * 0.02, frame.top + w * 0.02, frame.width - w * 0.04, frame.height - w * 0.04);
  ctx.restore();

  const half = (flip: boolean): void => {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    if (flip) ctx.rotate(Math.PI);
    // Clipped to its own half, so the two figures meet at the waist.
    ctx.beginPath();
    ctx.rect(-frame.width / 2 + w * 0.025, -frame.height / 2 + w * 0.025, frame.width - w * 0.05, frame.height / 2 - w * 0.025);
    ctx.clip();

    const unit = w * 0.01;
    const headY = -h * 0.2;

    // Robes: a bell of colour from the shoulders to the waist.
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(-unit * 24, 0);
    ctx.bezierCurveTo(-unit * 24, -h * 0.09, -unit * 15, -h * 0.125, -unit * 6, -h * 0.13);
    ctx.lineTo(unit * 6, -h * 0.13);
    ctx.bezierCurveTo(unit * 15, -h * 0.125, unit * 24, -h * 0.09, unit * 24, 0);
    ctx.closePath();
    ctx.fill();

    // A facing down the front of them, and a chain across it.
    ctx.fillStyle = STOCK;
    ctx.beginPath();
    ctx.moveTo(-unit * 4.5, -h * 0.13);
    ctx.lineTo(unit * 4.5, -h * 0.13);
    ctx.lineTo(unit * 7.5, 0);
    ctx.lineTo(-unit * 7.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = colour;
    for (let stud = 0; stud < 3; stud++) {
      ctx.beginPath();
      ctx.arc(0, -h * 0.1 + stud * h * 0.038, unit * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // The head.
    ctx.fillStyle = STOCK;
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1, unit * 0.9);
    ctx.beginPath();
    ctx.ellipse(0, headY, unit * 9.5, unit * 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Hair, by rank: a king's beard, a queen's fall, a jack's crop.
    ctx.fillStyle = INK;
    if (rank === 11) {
      ctx.beginPath();
      ctx.moveTo(-unit * 8.6, headY + unit * 3);
      ctx.quadraticCurveTo(0, headY + unit * 22, unit * 8.6, headY + unit * 3);
      ctx.quadraticCurveTo(0, headY + unit * 10, -unit * 8.6, headY + unit * 3);
      ctx.fill();
    } else if (rank === 10) {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * unit * 8.5, headY - unit * 7);
        ctx.quadraticCurveTo(side * unit * 15, headY + unit * 4, side * unit * 11, headY + unit * 15);
        ctx.quadraticCurveTo(side * unit * 8, headY + unit * 6, side * unit * 9.2, headY - unit * 2);
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.ellipse(0, headY - unit * 5, unit * 9.8, unit * 7.5, 0, Math.PI, Math.PI * 2);
      ctx.fill();
    }

    // Where the eyes would be.
    ctx.fillStyle = INK;
    ctx.fillRect(-unit * 7.4, headY - unit * 2.6, unit * 14.8, unit * 3.4);
    // And a mouth that is only a line.
    ctx.fillRect(-unit * 3, headY + unit * 5.6, unit * 6, unit * 0.9);

    // What they wear on their heads.
    ctx.fillStyle = colour;
    const brow = headY - unit * 10;
    ctx.beginPath();
    if (rank === 11) {
      // A crown: five points.
      ctx.moveTo(-unit * 11, brow);
      ctx.lineTo(-unit * 12.5, brow - unit * 11);
      ctx.lineTo(-unit * 6.5, brow - unit * 5.5);
      ctx.lineTo(-unit * 3.2, brow - unit * 12.5);
      ctx.lineTo(0, brow - unit * 6);
      ctx.lineTo(unit * 3.2, brow - unit * 12.5);
      ctx.lineTo(unit * 6.5, brow - unit * 5.5);
      ctx.lineTo(unit * 12.5, brow - unit * 11);
      ctx.lineTo(unit * 11, brow);
    } else if (rank === 10) {
      // A coronet: a low band with three beads on it.
      ctx.moveTo(-unit * 10.5, brow + unit * 1.5);
      ctx.quadraticCurveTo(0, brow - unit * 7, unit * 10.5, brow + unit * 1.5);
      ctx.lineTo(unit * 9.5, brow + unit * 4.5);
      ctx.quadraticCurveTo(0, brow - unit * 3, -unit * 9.5, brow + unit * 4.5);
    } else {
      // A cap, pulled down on one side.
      ctx.moveTo(-unit * 11.5, brow + unit * 4);
      ctx.quadraticCurveTo(-unit * 9, brow - unit * 8, unit * 3, brow - unit * 6.5);
      ctx.quadraticCurveTo(unit * 13, brow - unit * 4, unit * 11, brow + unit * 5);
      ctx.quadraticCurveTo(0, brow - unit * 1, -unit * 11.5, brow + unit * 4);
    }
    ctx.closePath();
    ctx.fill();
    if (rank === 10) {
      for (const bx of [-unit * 6, 0, unit * 6]) {
        ctx.beginPath();
        ctx.arc(bx, brow - unit * (bx === 0 ? 5.6 : 3.4), unit * 1.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (rank === 9) {
      // The feather.
      ctx.strokeStyle = colour;
      ctx.lineWidth = unit * 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(unit * 5, brow - unit * 5);
      ctx.quadraticCurveTo(unit * 14, brow - unit * 15, unit * 18, brow - unit * 8);
      ctx.stroke();
    }

    // The suit, where a hand would hold it.
    ctx.fillStyle = colour;
    ctx.save();
    ctx.translate(-unit * 16.5, -h * 0.285);
    drawSuit(ctx, suit, h * 0.085);
    ctx.restore();
    ctx.restore();
  };
  half(false);
  half(true);

  // The waist: a band where the two figures meet.
  ctx.save();
  ctx.fillStyle = colour;
  ctx.fillRect(frame.left + w * 0.025, h / 2 - h * 0.006, frame.width - w * 0.05, h * 0.012);
  ctx.restore();
}

/**
 * The back.
 *
 * A lattice, a border and a medallion, and the same either way up — a back that
 * could be told from its own reflection would be a marked deck. Whatever is in
 * the medallion, it has seven points.
 */
function drawBack(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  const w = CELL.width;
  const h = CELL.height;

  ctx.save();
  cardPath(ctx, x, y);
  ctx.clip();
  ctx.translate(x, y);

  // A pale margin, as a printed back has.
  ctx.fillStyle = STOCK_EDGE;
  ctx.fillRect(0, 0, w, h);

  const margin = w * 0.085;
  const field = ctx.createRadialGradient(w / 2, h / 2, w * 0.1, w / 2, h / 2, h * 0.6);
  field.addColorStop(0, BACK);
  field.addColorStop(1, BACK_DEEP);
  ctx.fillStyle = field;
  ctx.beginPath();
  ctx.roundRect(margin, margin, w - margin * 2, h - margin * 2, CORNER * 0.5);
  ctx.fill();
  ctx.clip();

  // The lattice: two sets of lines crossing, which is all a diaper pattern is.
  ctx.strokeStyle = BACK_LINE;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = Math.max(0.8, w * 0.006);
  const step = w * 0.085;
  for (let offset = -h; offset < w + h; offset += step) {
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset + h * 0.62, h);
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset - h * 0.62, h);
    ctx.stroke();
  }
  // A dot where the lines would cross, on alternate rows.
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = BACK_LINE;
  for (let row = 0; row * step * 0.806 < h; row++) {
    for (let column = -1; column * step < w + step; column++) {
      const px = column * step + (row % 2 === 0 ? 0 : step / 2);
      ctx.beginPath();
      ctx.arc(px, row * step * 0.806, w * 0.008, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // An inner rule.
  ctx.strokeStyle = BACK_LINE;
  ctx.lineWidth = Math.max(1, w * 0.01);
  ctx.beginPath();
  ctx.roundRect(margin + w * 0.04, margin + w * 0.04, w - (margin + w * 0.04) * 2, h - (margin + w * 0.04) * 2, CORNER * 0.3);
  ctx.stroke();

  // The medallion.
  const radius = w * 0.24;
  ctx.translate(w / 2, h / 2);
  ctx.fillStyle = BACK_DEEP;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = Math.max(0.8, w * 0.006);
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.86, 0, Math.PI * 2);
  ctx.stroke();

  // Two heptagrams, one the other way up, so the whole reads the same inverted.
  for (const turned of [0, Math.PI]) {
    ctx.beginPath();
    for (let point = 0; point <= 7; point++) {
      const angle = turned + ((point * 3) % 7) * ((Math.PI * 2) / 7) - Math.PI / 2;
      const px = Math.cos(angle) * radius * 0.8;
      const py = Math.sin(angle) * radius * 0.8;
      if (point === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.fillStyle = BACK_LINE;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.1, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawBlank(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  // The card edges. A flat off-white so a stack reads as paper, not plastic.
  ctx.fillStyle = '#cfc7b8';
  ctx.fillRect(x, y, CELL.width, CELL.height);
}
