/**
 * Where the pips go.
 *
 * A playing card is not a rank in the middle of a rectangle: it is a specific,
 * centuries-old arrangement that people read without looking. Six is two columns
 * of three; seven is six with one more between the top pair; eight is seven with
 * its mirror below. Everything in the bottom half is printed upside down, so the
 * card reads the same either way up.
 *
 * Positions are fractions of the card, so the layout is resolution-independent
 * and testable without a canvas.
 */

export interface Pip {
  /** 0 at the left edge, 1 at the right. */
  x: number;
  /** 0 at the top, 1 at the bottom. */
  y: number;
  /** Printed upside down, as everything below the middle is. */
  inverted: boolean;
}

/** The two pip columns, and the middle. */
const LEFT = 0.29;
const RIGHT = 0.71;
const MIDDLE = 0.5;

/** The rows a pip can sit on. */
const TOP = 0.2;
const BOTTOM = 0.8;
const CENTRE = 0.5;
/** The two inner rows of a four-row card (eight, nine, ten). */
const UPPER = 0.4;
const LOWER = 0.6;
/** Where the odd pip of a seven sits, between the top pair and the middle. */
const BETWEEN_TOP = 0.35;
const BETWEEN_BOTTOM = 0.65;
/** And for a ten, whose columns are already four deep. */
const TEN_UPPER = 0.3;
const TEN_LOWER = 0.7;

function at(x: number, y: number): Pip {
  // Everything below the middle of the card is printed upside down.
  return { x, y, inverted: y > 0.5 + 1e-9 };
}

function column(x: number, ys: number[]): Pip[] {
  return ys.map((y) => at(x, y));
}

/**
 * The pips for a rank, in the order a printer would lay them.
 *
 * `rank` is 0-based, as everywhere else in this codebase: 0 is a deuce and 12 is
 * an ace. Court cards have no pip layout — they get a figure instead — and an
 * ace gets a single large one, which the renderer scales up.
 */
export function pipsFor(rank: number): Pip[] {
  switch (rank) {
    case 0: // two
      return column(MIDDLE, [TOP, BOTTOM]);
    case 1: // three
      return column(MIDDLE, [TOP, CENTRE, BOTTOM]);
    case 2: // four
      return [...column(LEFT, [TOP, BOTTOM]), ...column(RIGHT, [TOP, BOTTOM])];
    case 3: // five
      return [...pipsFor(2), at(MIDDLE, CENTRE)];
    case 4: // six
      return [
        ...column(LEFT, [TOP, CENTRE, BOTTOM]),
        ...column(RIGHT, [TOP, CENTRE, BOTTOM]),
      ];
    case 5: // seven
      return [...pipsFor(4), at(MIDDLE, BETWEEN_TOP)];
    case 6: // eight
      return [...pipsFor(5), at(MIDDLE, BETWEEN_BOTTOM)];
    case 7: // nine
      return [
        ...column(LEFT, [TOP, UPPER, LOWER, BOTTOM]),
        ...column(RIGHT, [TOP, UPPER, LOWER, BOTTOM]),
        at(MIDDLE, CENTRE),
      ];
    case 8: // ten
      return [
        ...column(LEFT, [TOP, UPPER, LOWER, BOTTOM]),
        ...column(RIGHT, [TOP, UPPER, LOWER, BOTTOM]),
        at(MIDDLE, TEN_UPPER),
        at(MIDDLE, TEN_LOWER),
      ];
    case 12: // ace
      return [at(MIDDLE, CENTRE)];
    default: // jack, queen, king
      return [];
  }
}

/** True for the ranks that carry a figure rather than a count of pips. */
export function isCourt(rank: number): boolean {
  return rank >= 9 && rank <= 11;
}
