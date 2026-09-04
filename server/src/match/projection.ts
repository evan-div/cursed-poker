import {
  elapsedAtEndOfLevel,
  levelAt,
  type Card,
  type ClientView,
  type HandView,
  type LevelView,
  type PlayerView,
  type PresenceFrame,
  type SeatView,
  type SelfView,
} from '@cursed/shared';
import { legalActions } from '../poker/index.js';
import { elapsedMs, findPlayer, type MatchState, type PlayerRecord } from './match-state.js';
import { hasPeeked, projectPresence } from './presence.js';

/**
 * The hidden-information boundary.
 *
 * THIS IS THE ONLY MODULE IN THE SERVER THAT MAY TURN MATCH STATE INTO
 * SOMETHING A CLIENT RECEIVES. If a second one ever appears, the guarantee this
 * project rests on becomes two guarantees, and then none.
 *
 * There are two exits, because the protocol carries two rates of information:
 *
 *   - `projectForViewer` — the situation, per viewer, on every change.
 *   - `presenceFrame` — bodies, identical for everybody, on a fixed tick.
 *
 * The second one is a broadcast precisely *because* it has no viewer-specific
 * half. Everything in a presence frame is something a person sitting at this
 * table could see with their own eyes, which is a property the tests check by
 * walking the frame rather than by trusting this paragraph.
 *
 * The rules `projectForViewer` enforces:
 *
 *   1. The deck never leaves the process, in any form, ever.
 *   2. A viewer sees their own hole cards, and only after they have looked at
 *      them — see `SelfView.holeCards` for why the look is load-bearing.
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

/**
 * The table's bodies, as everyone sees them.
 *
 * No viewer argument, deliberately: presence has no hidden half, and the type
 * system says so. Adding one would be the first step toward a second hidden-
 * information boundary, so it should be argued for loudly if it ever happens.
 */
export function presenceFrame(match: MatchState, now: number): PresenceFrame {
  const seatIndices = (match.table?.seats ?? [])
    .filter((seat) => seat.seated)
    .map((seat) => seat.seatIndex);

  const connected = new Set(
    match.players
      .filter((player) => player.connected && player.eliminatedAt === null)
      .map((player) => player.seatIndex),
  );

  return projectPresence(match.presence, { seatIndices, connected }, now);
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
    return { playerId: '', seatIndex: null, holeCards: null, hasPeeked: false, legalActions: null };
  }

  const hand = match.table?.hand;
  const seat = hand?.seats.find((s) => s.seatIndex === viewer.seatIndex);

  // Cards reach their owner only once they have lifted them. Until then the
  // client has nothing to render and nothing to leak, which is the point: a
  // modified client cannot skip a gesture it never received the cards without.
  const looked = hasPeeked(match.presence, viewer.seatIndex, hand?.handNumber ?? null);

  // The viewer's own cards, and only ever from their own seat.
  const holeCards: Card[] | null = looked && seat?.holeCards ? [...seat.holeCards] : null;

  const isTheirTurn = hand !== undefined && hand !== null && hand.actingSeat === viewer.seatIndex;

  return {
    playerId: viewer.playerId,
    seatIndex: viewer.seatIndex,
    holeCards,
    hasPeeked: looked,
    legalActions: isTheirTurn && hand ? legalActions(hand, viewer.seatIndex) : null,
  };
}
