import type { BlindStructure, HandResult, MatchPhase, MatchStatus } from '@cursed/shared';
import type { TableState } from '../poker/index.js';

/**
 * Authoritative match state.
 *
 * Everything the server knows about one lobby. It is plain JSON-serialisable
 * data — no class instances, no timers — so it can be snapshotted, replayed and
 * diffed. Timers and I/O live in the `Match` controller that owns this.
 *
 * SERVER ONLY. `table.hand` carries the deck and every player's hole cards.
 * Nothing in here reaches a client except through `projectForViewer`.
 */

export interface PlayerRecord {
  playerId: string;
  displayName: string;
  seatIndex: number;
  connected: boolean;
  ready: boolean;
  /** Epoch ms when the Dealer took them, or null while they are still playing. */
  eliminatedAt: number | null;
  /** Finishing position, set at elimination. 1 is the winner. */
  place: number | null;
  /**
   * Consecutive action timeouts. Used to decide when a disconnected player is
   * folding rather than thinking.
   */
  timeouts: number;
}

export interface MatchState {
  roomCode: string;
  status: MatchStatus;
  phase: MatchPhase;
  hostPlayerId: string;
  seatCount: number;
  players: PlayerRecord[];
  structure: BlindStructure;
  table: TableState | null;

  /**
   * The blind clock, split so it can be paused. Phase 8's perk ritual and any
   * future forced interruption stop the clock rather than letting blinds climb
   * through a cutscene.
   */
  clockElapsedMs: number;
  clockRunningSince: number | null;

  /** Epoch ms by which the acting seat must act, or null. */
  actionDeadline: number | null;
  /** The hand just finished, held so players can read the result. */
  lastResult: HandResult | null;
  winnerPlayerId: string | null;
}

export function elapsedMs(match: MatchState, now: number): number {
  const running = match.clockRunningSince === null ? 0 : now - match.clockRunningSince;
  return match.clockElapsedMs + running;
}

export function findPlayer(match: MatchState, playerId: string): PlayerRecord | undefined {
  return match.players.find((p) => p.playerId === playerId);
}

export function findPlayerBySeat(match: MatchState, seatIndex: number): PlayerRecord | undefined {
  return match.players.find((p) => p.seatIndex === seatIndex);
}

/** Players who have not been eliminated. */
export function livingPlayers(match: MatchState): PlayerRecord[] {
  return match.players.filter((p) => p.eliminatedAt === null);
}
