import {
  elapsedAtEndOfLevel,
  levelAt,
  type Card,
  type ClientView,
  type HandView,
  type LevelView,
  type PlayerView,
  type SeatView,
  type SelfView,
} from '@cursed/shared';
import { legalActions } from '../poker/index.js';
import { elapsedMs, findPlayer, type MatchState, type PlayerRecord } from './match-state.js';

/**
 * The hidden-information boundary.
 *
 * THIS IS THE ONLY FUNCTION IN THE SERVER THAT MAY TURN MATCH STATE INTO
 * SOMETHING A CLIENT RECEIVES. If a second one ever appears, the guarantee this
 * project rests on becomes two guarantees, and then none.
 *
 * The rules it enforces:
 *
 *   1. The deck never leaves the process, in any form, ever.
 *   2. A viewer sees their own hole cards and nobody else's.
 *   3. Another player's cards appear only in a showdown reveal — cards poker
 *      itself has already made public.
 *   4. Nothing about a player's stack, position or history is hidden; poker is
 *      a game of hidden *cards*, not hidden chips.
 *
 * `projection.test.ts` asserts 1-3 structurally over fuzzed live hands, for
 * every viewer at the table, rather than trusting this comment.
 */
export function projectForViewer(match: MatchState, viewerId: string | null, now: number): ClientView {
  const viewer = viewerId === null ? undefined : findPlayer(match, viewerId);

  return {
    serverTime: now,
    room: {
      code: match.roomCode,
      status: match.status,
      phase: match.phase,
      hostPlayerId: match.hostPlayerId,
    },
    level: projectLevel(match, now),
    players: match.players.map(projectPlayer(match.hostPlayerId)),
    hand: projectHand(match),
    you: projectSelf(match, viewer),
    lastResult: match.lastResult,
    winnerPlayerId: match.winnerPlayerId,
  };
}

function projectPlayer(hostPlayerId: string) {
  return (player: PlayerRecord): PlayerView => ({
    playerId: player.playerId,
    displayName: player.displayName,
    seatIndex: player.seatIndex,
    connected: player.connected,
    ready: player.ready,
    isHost: player.playerId === hostPlayerId,
    seated: player.eliminatedAt === null,
  });
}

function projectLevel(match: MatchState, now: number): LevelView | null {
  if (!match.table) return null;

  // The level actually in play, not the one the wall clock has reached. A hand
  // always finishes at the blinds it started with, so showing a player 200/400
  // while they are posting 50/100 would be a lie.
  const index = match.table.levelIndex;
  const level = levelAt(match.structure, index);
  const endOfLevel = elapsedAtEndOfLevel(match.structure, index);

  // A paused clock has no end time, which is how the client knows to freeze the
  // countdown rather than let it run down on its own. `endsAt` in the past means
  // the level is over and the blinds go up when the next hand is dealt — clients
  // should clamp the countdown at zero rather than show a negative number.
  const endsAt =
    endOfLevel === null || match.clockRunningSince === null
      ? null
      : now + (endOfLevel * 1000 - elapsedMs(match, now));

  return {
    level: level.level,
    smallBlind: level.smallBlind,
    bigBlind: level.bigBlind,
    ante: level.ante,
    endsAt,
  };
}

function projectHand(match: MatchState): HandView | null {
  const hand = match.table?.hand;
  if (!match.table || !hand) return null;

  // Reveals are cards poker has already made public. A hand won without a
  // showdown produces none, and a live hand produces none either.
  const reveals = new Map((hand.result?.showdown ?? []).map((r) => [r.seatIndex, r]));

  const seats: SeatView[] = match.table.seats
    .filter((tableSeat) => tableSeat.seated)
    .map((tableSeat): SeatView => {
      const handSeat = hand.seats.find((s) => s.seatIndex === tableSeat.seatIndex);
      const player = match.players.find((p) => p.seatIndex === tableSeat.seatIndex);
      const reveal = reveals.get(tableSeat.seatIndex);

      return {
        seatIndex: tableSeat.seatIndex,
        playerId: tableSeat.playerId,
        displayName: player?.displayName ?? tableSeat.playerId,
        stack: handSeat?.stack ?? tableSeat.stack,
        betThisRound: handSeat?.betThisRound ?? 0,
        folded: handSeat?.folded ?? false,
        allIn: handSeat?.allIn ?? false,
        inHand: handSeat !== undefined,
        connected: player?.connected ?? false,
        revealedCards: reveal ? [...reveal.holeCards] : null,
        handCategory: reveal?.category ?? null,
        bestFive: reveal ? [...reveal.bestFive] : null,
      };
    });

  return {
    handNumber: hand.handNumber,
    phase: hand.phase,
    buttonSeat: hand.buttonSeat,
    smallBlindSeat: hand.smallBlindSeat,
    bigBlindSeat: hand.bigBlindSeat,
    board: [...hand.board],
    currentBet: hand.currentBet,
    potTotal: hand.seats.reduce((sum, s) => sum + s.totalCommitted, 0),
    actingSeat: hand.actingSeat,
    actionDeadline: hand.actingSeat === null ? null : match.actionDeadline,
    seats,
  };
}

function projectSelf(match: MatchState, viewer: PlayerRecord | undefined): SelfView {
  if (!viewer) {
    return { playerId: '', seatIndex: null, holeCards: null, legalActions: null };
  }

  const hand = match.table?.hand;
  const seat = hand?.seats.find((s) => s.seatIndex === viewer.seatIndex);

  // The viewer's own cards, and only ever from their own seat.
  const holeCards: Card[] | null = seat?.holeCards ? [...seat.holeCards] : null;

  const isTheirTurn = hand !== undefined && hand !== null && hand.actingSeat === viewer.seatIndex;

  return {
    playerId: viewer.playerId,
    seatIndex: viewer.seatIndex,
    holeCards,
    legalActions: isTheirTurn && hand ? legalActions(hand, viewer.seatIndex) : null,
  };
}
