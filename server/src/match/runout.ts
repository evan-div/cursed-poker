import type { MatchEvent } from '@cursed/shared';

/**
 * Cutting a finished hand into acts.
 *
 * The poker engine is a pure function with nobody to wait for. When the last
 * player who could still bet calls an all-in, it deals whatever is left of the
 * board, ranks the hands and pays the pot, all in the one step, and hands back
 * every event at once. That is correct — and sent to the table as it stands, the
 * one moment in poker everybody leans in for arrives as a finished result.
 *
 * So the match holds it back and tells it in order: the hands go face up, then
 * a street at a time, then who won. Nothing here deals a card or changes one.
 * The hand is already over; this only decides how fast the table finds out.
 */

export interface RunoutActs {
  /** What happened before any card came: the last bet, and any chips returned. */
  opening: MatchEvent[];
  /** One act per street still to come, each beginning with its `STREET_DEALT`. */
  streets: MatchEvent[][];
  /** The ending: the showdown, the pots, the result. */
  closing: MatchEvent[];
}

/**
 * Splits one engine step into acts, or returns null if it is not a runout.
 *
 * A runout is a step in which the board was dealt *and* the hand reached a
 * showdown: streets came with nobody able to act on them. A street followed by
 * a decision is ordinary play, and a showdown with no street before it is an
 * ordinary river.
 */
export function splitRunout(events: readonly MatchEvent[]): RunoutActs | null {
  const firstStreet = events.findIndex((event) => event.type === 'STREET_DEALT');
  const showdown = events.findIndex((event) => event.type === 'SHOWDOWN');
  if (firstStreet < 0 || showdown < firstStreet) return null;

  const opening = events.slice(0, firstStreet);
  const streets: MatchEvent[][] = [];
  const closing: MatchEvent[] = [];

  for (const event of events.slice(firstStreet)) {
    if (closing.length > 0 || event.type === 'SHOWDOWN') {
      closing.push(event);
    } else if (event.type === 'STREET_DEALT') {
      streets.push([event]);
    } else if (event.type === 'UNCALLED_RETURNED') {
      // The engine reports this while it is settling up, after the river. At
      // the table it happened when the betting stopped: the chips nobody could
      // call went straight back.
      opening.push(event);
    } else {
      streets[streets.length - 1]!.push(event);
    }
  }
  return { opening, streets, closing };
}
