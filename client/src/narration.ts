import type { Card, ClientView, MatchEvent } from '@cursed/shared';

/**
 * Turns the server's event stream into log lines.
 *
 * Presentation only. The log is a record of what the server said happened; it
 * is never consulted to decide anything, and if it disagrees with the view then
 * the view is right.
 *
 * A line is a list of pieces rather than a string, because cards in it are
 * drawn rather than spelled. "flop: 9h 6d Kh" is a thing you decode; three
 * little cards is a thing you glance at, and glancing is what a log at the edge
 * of the screen is for.
 */

/** One piece of a log line: some words, or a card to draw. */
export type LogPiece = string | { card: Card };
export type LogLine = LogPiece[];

/** Sugar for the common shape — some text with a run of cards inside it. */
function line(...pieces: (string | Card[] | LogPiece)[]): LogLine {
  const out: LogLine = [];
  for (const piece of pieces) {
    if (Array.isArray(piece)) out.push(...piece.map((card) => ({ card })));
    else out.push(piece);
  }
  return out;
}

export function describeEvent(event: MatchEvent, view: ClientView | null): LogLine | null {
  const who = (seatIndex: number): string =>
    view?.hand?.seats.find((s) => s.seatIndex === seatIndex)?.displayName ?? `Seat ${seatIndex}`;
  const named = (playerId: string): string =>
    view?.players.find((p) => p.playerId === playerId)?.displayName ?? 'Someone';
  const money = (n: number) => n.toLocaleString('en-US');

  switch (event.type) {
    case 'PLAYER_JOINED':
      return line(`${event.displayName} sits down.`);
    case 'PLAYER_LEFT':
      return line(`${named(event.playerId)} leaves the table.`);
    case 'PLAYER_CONNECTION':
      return line(`${named(event.playerId)} ${event.connected ? 'is back' : 'has gone quiet'}.`);
    case 'MATCH_STARTED':
      return line(`The Dealer shuffles. ${event.seatCount} players.`);
    case 'BLIND_LEVEL_UP':
      return line(
        `Blinds rise to ${money(event.smallBlind)}/${money(event.bigBlind)}${
          event.ante > 0 ? ` with a ${money(event.ante)} ante` : ''
        }.`,
      );
    case 'PLAYER_TIMED_OUT':
      return line(
        `${who(event.seatIndex)} ran out of time and ${event.forcedFold ? 'folded' : 'checked'}.`,
      );
    case 'PLAYER_ELIMINATED':
      return line(`${named(event.playerId)} is taken. Finished ${ordinal(event.place)}.`);
    case 'MATCH_ENDED':
      return line(`${named(event.winnerPlayerId)} is the last one at the table.`);

    case 'HAND_STARTED':
      return line(`— Hand ${event.handNumber} —`);
    case 'ANTE_POSTED':
      return line(`${who(event.seatIndex)} posts an ante of ${money(event.amount)}.`);
    case 'BLIND_POSTED':
      return line(
        `${who(event.seatIndex)} posts the ${event.blind === 'SMALL' ? 'small' : 'big'} blind (${money(event.amount)}).`,
      );
    case 'PLAYER_ACTED':
      return line(`${who(event.seatIndex)} ${describeAction(event.action, money)}.`);
    case 'STREET_DEALT':
      return line(`${event.street.toLowerCase()} `, [...event.cards]);
    case 'UNCALLED_RETURNED':
      return line(`${money(event.amount)} returned to ${who(event.seatIndex)} — nobody called it.`);
    case 'SHOWDOWN':
      return event.reveals.flatMap((reveal, index) =>
        line(
          index === 0 ? '' : ' · ',
          `${who(reveal.seatIndex)} shows `,
          [...reveal.holeCards],
          ` ${category(reveal.category)}`,
        ),
      );
    case 'POT_AWARDED':
      return line(
        `${who(event.seatIndex)} takes ${money(event.amount)}${event.oddChip ? ' (odd chip)' : ''}.`,
      );

    // Bookkeeping the log does not need.
    case 'HOLE_CARDS_DEALT':
    case 'ACTION_REQUIRED':
    case 'BETTING_ROUND_CLOSED':
    case 'HAND_COMPLETE':
      return null;
  }
}

function describeAction(
  action: Extract<MatchEvent, { type: 'PLAYER_ACTED' }>['action'],
  money: (n: number) => string,
): string {
  switch (action.type) {
    case 'FOLD':
      return 'folds';
    case 'CHECK':
      return 'checks';
    case 'CALL':
      return `calls ${money(action.amount)}`;
    case 'BET':
      return `bets ${money(action.to)}`;
    case 'RAISE':
      return `raises to ${money(action.to)}`;
  }
}

function category(name: string): string {
  return name.replaceAll('_', ' ').toLowerCase();
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}
