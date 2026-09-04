import { cardsToString, type ClientView, type MatchEvent } from '@cursed/shared';

/**
 * Turns the server's event stream into log lines.
 *
 * Presentation only. The log is a record of what the server said happened; it
 * is never consulted to decide anything, and if it disagrees with the view then
 * the view is right.
 */
export function describeEvent(event: MatchEvent, view: ClientView | null): string | null {
  const who = (seatIndex: number): string =>
    view?.hand?.seats.find((s) => s.seatIndex === seatIndex)?.displayName ?? `Seat ${seatIndex}`;
  const named = (playerId: string): string =>
    view?.players.find((p) => p.playerId === playerId)?.displayName ?? 'Someone';
  const money = (n: number) => n.toLocaleString('en-US');

  switch (event.type) {
    case 'PLAYER_JOINED':
      return `${event.displayName} sits down.`;
    case 'PLAYER_LEFT':
      return `${named(event.playerId)} leaves the table.`;
    case 'PLAYER_CONNECTION':
      return `${named(event.playerId)} ${event.connected ? 'is back' : 'has gone quiet'}.`;
    case 'MATCH_STARTED':
      return `The Dealer shuffles. ${event.seatCount} players.`;
    case 'BLIND_LEVEL_UP':
      return `Blinds rise to ${money(event.smallBlind)}/${money(event.bigBlind)}${
        event.ante > 0 ? ` with a ${money(event.ante)} ante` : ''
      }.`;
    case 'PLAYER_TIMED_OUT':
      return `${who(event.seatIndex)} ran out of time and ${event.forcedFold ? 'folded' : 'checked'}.`;
    case 'PLAYER_ELIMINATED':
      return `${named(event.playerId)} is taken. Finished ${ordinal(event.place)}.`;
    case 'MATCH_ENDED':
      return `${named(event.winnerPlayerId)} is the last one at the table.`;

    case 'HAND_STARTED':
      return `— Hand ${event.handNumber} —`;
    case 'ANTE_POSTED':
      return `${who(event.seatIndex)} posts an ante of ${money(event.amount)}.`;
    case 'BLIND_POSTED':
      return `${who(event.seatIndex)} posts the ${event.blind === 'SMALL' ? 'small' : 'big'} blind (${money(event.amount)}).`;
    case 'PLAYER_ACTED':
      return `${who(event.seatIndex)} ${describeAction(event.action, money)}.`;
    case 'STREET_DEALT':
      return `${event.street.toLowerCase()}: ${cardsToString(event.cards)}`;
    case 'UNCALLED_RETURNED':
      return `${money(event.amount)} returned to ${who(event.seatIndex)} — nobody called it.`;
    case 'SHOWDOWN':
      return event.reveals
        .map((r) => `${who(r.seatIndex)} shows ${cardsToString(r.holeCards)} — ${category(r.category)}`)
        .join(' · ');
    case 'POT_AWARDED':
      return `${who(event.seatIndex)} takes ${money(event.amount)}${event.oddChip ? ' (odd chip)' : ''}.`;

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
