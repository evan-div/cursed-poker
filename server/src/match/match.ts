import {
  DEFAULT_BLIND_STRUCTURE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PRESENCE,
  SEAT_COUNT,
  levelAt,
  levelIndexForElapsed,
  type BlindStructure,
  type ClientView,
  type ErrorCode,
  type MatchEvent,
  type PlayerAction,
  type PresenceFrame,
  type PresenceInput,
} from '@cursed/shared';
import {
  CryptoRandomSource,
  act,
  contestingSeats,
  createTable,
  eliminate,
  legalActions,
  setLevelIndex,
  settleHand,
  startHand,
  type RandomSource,
} from '../poker/index.js';
import { SystemClock, type Clock, type TimerHandle } from './clock.js';
import { createDealer, updateDealer, type DealerContext } from './dealer.js';
import {
  elapsedMs,
  findPlayer,
  findPlayerBySeat,
  livingPlayers,
  type MatchState,
  type PlayerRecord,
} from './match-state.js';
import {
  createPresence,
  forgetSeat,
  markPeeked,
  reportPresence,
  resetForHand,
} from './presence.js';
import { presenceFrame, projectForViewer, roomDread } from './projection.js';

/**
 * The outer state machine: one lobby, from empty room to last player standing.
 *
 * It owns the loop, the clocks and the timeouts. It does not own poker — every
 * poker question goes to the engine, and the engine's answer is final.
 *
 * The structure that matters is the gap between hands. `settleAndAdvance` runs
 * `BETWEEN_HANDS`, and that is where every future supernatural system plugs in:
 * the sacrifice window, the perk ritual, the elimination sequence. There is no
 * path from `HAND_IN_PROGRESS` into any of them, which is what guarantees a
 * sacrifice can never interrupt a hand.
 */

export class MatchError extends Error {
  override readonly name = 'MatchError';
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface MatchTimings {
  /** How long a player has to act. */
  actionTimeoutMs: number;
  /** Shorter clock for a disconnected player, so the table is not held hostage. */
  disconnectedActionTimeoutMs: number;
  /** How long a finished showdown stays on screen before the table is settled. */
  showdownDisplayMs: number;
  /** Same, for a hand that ended without a showdown. */
  foldedHandDisplayMs: number;
  /** Breath between settling one hand and dealing the next. */
  betweenHandsMs: number;
}

export const DEFAULT_TIMINGS: MatchTimings = {
  actionTimeoutMs: 30_000,
  disconnectedActionTimeoutMs: 6_000,
  showdownDisplayMs: 4_000,
  foldedHandDisplayMs: 1_500,
  betweenHandsMs: 1_500,
};

export interface MatchOptions {
  roomCode: string;
  hostPlayerId: string;
  structure?: BlindStructure;
  seatCount?: number;
  clock?: Clock;
  rng?: RandomSource;
  /** The Dealer's source of chance. Never the deck's — see `Match#dealerRng`. */
  dealerRng?: RandomSource;
  timings?: Partial<MatchTimings>;
}

/**
 * The events that are him physically doing something.
 *
 * Cards leaving his hands, a board turned over, the pot pushed to somebody. Not
 * a player betting — that is a player's hands, and he watches it.
 */
const MOVED_BY_HIS_HANDS = new Set<MatchEvent['type']>([
  'HOLE_CARDS_DEALT',
  'STREET_DEALT',
  'POT_AWARDED',
]);

export type MatchListener = (events: MatchEvent[]) => void;

export class Match {
  readonly state: MatchState;
  readonly #clock: Clock;
  readonly #rng: RandomSource;
  /**
   * The Dealer's own source of chance, and emphatically not the deck's.
   *
   * If he drew from `#rng`, the shuffle would depend on how often he had
   * twitched — the supernatural layer reaching the cards through a side door,
   * which is the one thing this whole project is arranged to prevent. Two
   * sources, always, and `match.test.ts` asserts the deck is unmoved by an hour
   * of him fidgeting.
   */
  readonly #dealerRng: RandomSource;
  readonly #timings: MatchTimings;
  readonly #listeners = new Set<MatchListener>();

  #timer: TimerHandle | null = null;
  #pendingEvents: MatchEvent[] = [];
  #disposed = false;

  constructor(options: MatchOptions) {
    this.#clock = options.clock ?? new SystemClock();
    this.#rng = options.rng ?? new CryptoRandomSource();
    this.#dealerRng = options.dealerRng ?? new CryptoRandomSource();
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };

    this.state = {
      roomCode: options.roomCode,
      status: 'LOBBY',
      phase: 'LOBBY',
      hostPlayerId: options.hostPlayerId,
      seatCount: options.seatCount ?? SEAT_COUNT,
      players: [],
      structure: options.structure ?? DEFAULT_BLIND_STRUCTURE,
      table: null,
      presence: createPresence(),
      dealer: createDealer(this.#clock.now()),
      startingPlayers: 0,
      sacrifices: 0,
      clockElapsedMs: 0,
      clockRunningSince: null,
      actionDeadline: null,
      lastResult: null,
      winnerPlayerId: null,
    };
  }

  // -------------------------------------------------------------------------
  // Subscriptions and views
  // -------------------------------------------------------------------------

  onUpdate(listener: MatchListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  viewFor(playerId: string | null): ClientView {
    return projectForViewer(this.state, playerId, this.#clock.now());
  }

  /**
   * Moves the bodies on. Called on the presence tick, before it broadcasts.
   *
   * Separate from `presenceFor` on purpose: a projection that mutates is a
   * projection nobody can call twice, and this one is called from a loop over
   * every room in the process. This is where the Dealer thinks.
   */
  tick(): void {
    if (this.#disposed) return;
    const now = this.#clock.now();
    updateDealer(this.state.dealer, this.#dealerContext(now), this.#dealerRng, now);
  }

  /**
   * The world the Dealer is allowed to react to.
   *
   * Assembled here, from public facts only. Every field is something a person
   * sitting at this table could see for themselves; nothing in it comes from a
   * deck, a hole card or a hand ranking. See `dealer.ts` for why that boundary
   * is the whole point, and `dealer.test.ts` for the test that holds it.
   */
  #dealerContext(now: number): DealerContext {
    const table = this.state.table;
    const hand = table?.hand ?? null;
    const seated = (table?.seats ?? []).filter((seat) => seat.seated).map((s) => s.seatIndex);

    return {
      dealtAt: this.state.dealer.dealtAt,
      now,
      handInProgress: this.state.phase === 'HAND_IN_PROGRESS',
      actingSeat: hand?.actingSeat ?? null,
      seats: seated,
      liftedSeats: this.state.presence
        .filter((record) => record.lift > 0.15 && now - record.lastReportAt < PRESENCE.graceMs)
        .map((record) => record.seatIndex),
      dread: roomDread(this.state, now),
    };
  }

  /** The table's bodies. Public to everyone, so there is no viewer argument. */
  presenceFor(): PresenceFrame {
    return presenceFrame(this.state, this.#clock.now());
  }

  dispose(): void {
    this.#disposed = true;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------

  join(playerId: string, displayName: string): PlayerRecord {
    const existing = findPlayer(this.state, playerId);
    if (existing) {
      existing.displayName = displayName;
      return existing;
    }
    if (this.state.status !== 'LOBBY') {
      throw new MatchError('ALREADY_STARTED', 'The match has already begun');
    }
    if (this.state.players.length >= MAX_PLAYERS) {
      throw new MatchError('ROOM_FULL', `This table seats ${MAX_PLAYERS}`);
    }

    const taken = new Set(this.state.players.map((p) => p.seatIndex));
    let seatIndex = 0;
    while (taken.has(seatIndex)) seatIndex++;

    const player: PlayerRecord = {
      playerId,
      displayName,
      seatIndex,
      connected: true,
      ready: false,
      eliminatedAt: null,
      place: null,
      timeouts: 0,
    };
    this.state.players.push(player);
    this.state.players.sort((a, b) => a.seatIndex - b.seatIndex);

    this.#emit({ type: 'PLAYER_JOINED', playerId, displayName, seatIndex });
    this.#flush();
    return player;
  }

  /** Removes a player. Only possible before the match starts. */
  leave(playerId: string): void {
    if (this.state.status !== 'LOBBY') {
      // Mid-match, leaving is a disconnect: the seat and its chips remain.
      this.setConnected(playerId, false);
      return;
    }
    const index = this.state.players.findIndex((p) => p.playerId === playerId);
    if (index < 0) return;
    forgetSeat(this.state.presence, this.state.players[index]!.seatIndex);
    this.state.players.splice(index, 1);

    if (this.state.hostPlayerId === playerId && this.state.players[0]) {
      this.state.hostPlayerId = this.state.players[0].playerId;
    }
    this.#emit({ type: 'PLAYER_LEFT', playerId });
    this.#flush();
  }

  setConnected(playerId: string, connected: boolean): void {
    const player = findPlayer(this.state, playerId);
    if (!player || player.connected === connected) return;
    player.connected = connected;
    if (connected) player.timeouts = 0;

    this.#emit({ type: 'PLAYER_CONNECTION', playerId, connected });

    // A player who drops on their turn should not hold the table for 30 seconds,
    // and one who comes back mid-turn deserves their full clock again.
    if (this.state.phase === 'HAND_IN_PROGRESS' && this.#actingPlayer()?.playerId === playerId) {
      this.#armActionTimer();
    }
    this.#flush();
  }

  setReady(playerId: string, ready: boolean): void {
    const player = findPlayer(this.state, playerId);
    if (!player) throw new MatchError('NOT_FOUND', 'You are not in this lobby');
    if (this.state.status !== 'LOBBY') return;
    player.ready = ready;
    this.#flush();
  }

  canStart(): boolean {
    return (
      this.state.status === 'LOBBY' &&
      this.state.players.length >= MIN_PLAYERS &&
      this.state.players.length <= MAX_PLAYERS &&
      this.state.players.every((p) => p.ready && p.connected)
    );
  }

  start(playerId: string): void {
    if (playerId !== this.state.hostPlayerId) {
      throw new MatchError('NOT_HOST', 'Only the host can start the match');
    }
    if (this.state.status !== 'LOBBY') {
      throw new MatchError('ALREADY_STARTED', 'The match has already begun');
    }
    if (this.state.players.length < MIN_PLAYERS) {
      throw new MatchError(
        'NOT_ENOUGH_PLAYERS',
        `This game needs at least ${MIN_PLAYERS} players`,
      );
    }
    if (!this.state.players.every((p) => p.ready)) {
      throw new MatchError('NOT_ENOUGH_PLAYERS', 'Everyone must be ready');
    }

    this.state.table = createTable({
      seats: this.state.players.map((p) => ({ seatIndex: p.seatIndex, playerId: p.playerId })),
      structure: this.state.structure,
      seatCount: this.state.seatCount,
    });
    this.state.status = 'IN_PROGRESS';
    // Fixed here and never touched again: the room's dread measures empty
    // chairs against how many were filled when the evening began.
    this.state.startingPlayers = this.state.players.length;
    this.state.clockRunningSince = this.#clock.now();

    this.#emit({ type: 'MATCH_STARTED', seatCount: this.state.players.length });
    this.#beginHand();
  }

  // -------------------------------------------------------------------------
  // Playing
  // -------------------------------------------------------------------------

  submitAction(playerId: string, handNumber: number, action: PlayerAction): void {
    const player = findPlayer(this.state, playerId);
    if (!player) throw new MatchError('NOT_FOUND', 'You are not in this match');

    const hand = this.state.table?.hand;
    if (this.state.phase !== 'HAND_IN_PROGRESS' || !hand) {
      throw new MatchError('NOT_YOUR_TURN', 'There is no hand to act in');
    }
    // Reject an action decided for a hand that has already ended, so a laggy
    // client cannot fold a hand it is no longer playing.
    if (hand.handNumber !== handNumber) {
      throw new MatchError('STALE_HAND', 'That action was for a hand that has ended');
    }
    if (hand.actingSeat !== player.seatIndex) {
      throw new MatchError('NOT_YOUR_TURN', 'It is not your turn');
    }

    player.timeouts = 0;
    this.#applyAction(player.seatIndex, action);
  }

  // -------------------------------------------------------------------------
  // Bodies
  // -------------------------------------------------------------------------

  /**
   * Records what a player's body is doing.
   *
   * Deliberately silent: it does not flush, because presence is broadcast on its
   * own tick. Pushing a full view every time somebody turned their head would be
   * six players' worth of chips, cards and legal actions fifteen times a second,
   * for a game in which nothing had happened.
   */
  reportPresence(playerId: string, input: PresenceInput): void {
    const player = findPlayer(this.state, playerId);
    if (!player || player.eliminatedAt !== null) return;
    reportPresence(this.state.presence, player.seatIndex, input, this.#clock.now());
  }

  /**
   * "I am lifting my cards."
   *
   * The reply is not the cards. It is a fresh view, which *contains* the cards
   * because the seat is now marked as having looked — the same single boundary
   * every other byte of match state goes through.
   *
   * Peeking is not narrated as an event. A permanent line in the log saying
   * "seat 3 checked their cards" would be a better record than anyone at a real
   * table has; observation here should be live, fallible and easy to miss.
   */
  peek(playerId: string, handNumber: number): void {
    const player = findPlayer(this.state, playerId);
    if (!player) throw new MatchError('NOT_FOUND', 'You are not in this match');

    const hand = this.state.table?.hand;
    if (this.state.phase !== 'HAND_IN_PROGRESS' || !hand) {
      throw new MatchError('NOT_YOUR_TURN', 'There is no hand to look at');
    }
    if (hand.handNumber !== handNumber) {
      throw new MatchError('STALE_HAND', 'That hand has ended');
    }

    const seat = hand.seats.find((s) => s.seatIndex === player.seatIndex);
    if (!seat?.holeCards) {
      throw new MatchError('ILLEGAL_ACTION', 'You have no cards in this hand');
    }

    const first = markPeeked(this.state.presence, player.seatIndex, handNumber, this.#clock.now());
    // Only the first look changes what this player may be sent, and only they
    // need telling. Later looks are already visible to the table through
    // presence and cost nothing here.
    if (first) this.#flush();
  }

  #applyAction(seatIndex: number, action: PlayerAction): void {
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;

    try {
      const step = act(this.state.table!, seatIndex, action);
      this.state.table = step.table;
      for (const event of step.events) this.#emit(event);
    } catch (error) {
      // Re-arm so a rejected action does not leave the table waiting forever.
      this.#armActionTimer();
      this.#flush();
      throw new MatchError('ILLEGAL_ACTION', (error as Error).message);
    }

    if (this.state.table!.status === 'AWAITING_SETTLEMENT') {
      this.#scheduleSettlement();
    } else {
      this.#armActionTimer();
    }
    this.#flush();
  }

  #actingPlayer(): PlayerRecord | undefined {
    const seat = this.state.table?.hand?.actingSeat;
    return seat === undefined || seat === null ? undefined : findPlayerBySeat(this.state, seat);
  }

  #armActionTimer(): void {
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;

    const hand = this.state.table?.hand;
    if (!hand || hand.actingSeat === null) {
      this.state.actionDeadline = null;
      return;
    }

    const player = this.#actingPlayer();
    const someoneElseIsWatching = this.state.players.some(
      (p) => p.connected && p.playerId !== player?.playerId && p.eliminatedAt === null,
    );
    // Only rush a disconnected player if there is somebody left to rush for. A
    // table that has entirely dropped out gets the full clock instead of
    // auto-folding its way through the match.
    const ms =
      player && !player.connected && someoneElseIsWatching
        ? this.#timings.disconnectedActionTimeoutMs
        : this.#timings.actionTimeoutMs;

    this.state.actionDeadline = this.#clock.now() + ms;
    this.#timer = this.#clock.setTimeout(() => this.#onActionTimeout(), ms);
  }

  #onActionTimeout(): void {
    if (this.#disposed) return;
    const hand = this.state.table?.hand;
    if (!hand || hand.actingSeat === null) return;

    const seatIndex = hand.actingSeat;
    const player = findPlayerBySeat(this.state, seatIndex);
    if (player) player.timeouts++;

    // Checking is free, so a timeout should never cost a player their hand when
    // it does not have to.
    const legal = legalActions(hand, seatIndex);
    const action: PlayerAction = legal.canCheck ? { type: 'CHECK' } : { type: 'FOLD' };

    this.#emit({ type: 'PLAYER_TIMED_OUT', seatIndex, forcedFold: !legal.canCheck });
    this.#applyAction(seatIndex, action);
  }

  // -------------------------------------------------------------------------
  // Between hands — the seam every supernatural system plugs into
  // -------------------------------------------------------------------------

  #scheduleSettlement(): void {
    const hand = this.state.table!.hand!;
    this.state.actionDeadline = null;
    this.state.lastResult = hand.result;

    const delay = hand.result?.showdown
      ? this.#timings.showdownDisplayMs
      : this.#timings.foldedHandDisplayMs;

    this.#timer = this.#clock.setTimeout(() => this.#settleAndAdvance(), delay);
  }

  #settleAndAdvance(): void {
    if (this.#disposed) return;

    const { table, settlement } = settleHand(this.state.table!);
    this.state.table = table;
    this.state.phase = 'BETWEEN_HANDS';

    // --- BETWEEN_HANDS ------------------------------------------------------
    // Phase 8 inserts the perk ritual here; Phase 9 inserts the sacrifice
    // window *before* elimination, so a busted player gets the chance to pay
    // for another hand. Until then a bust is simply final.
    this.#runEliminations(settlement.busted);
    // -----------------------------------------------------------------------

    const survivors = livingPlayers(this.state);
    if (survivors.length <= 1) {
      this.#endMatch(survivors[0]);
      return;
    }

    this.#timer = this.#clock.setTimeout(() => this.#beginHand(), this.#timings.betweenHandsMs);
    this.#flush();
  }

  #runEliminations(bustedSeats: readonly number[]): void {
    if (bustedSeats.length === 0) return;

    // When several players bust in the same hand, the one who brought more
    // chips to it finishes higher.
    const hand = this.state.table?.hand;
    const ordered = [...bustedSeats].sort((a, b) => {
      const stackOf = (seat: number) =>
        hand?.seats.find((s) => s.seatIndex === seat)?.stackAtStart ?? 0;
      return stackOf(a) - stackOf(b);
    });

    let place = livingPlayers(this.state).length;
    for (const seatIndex of ordered) {
      const player = findPlayerBySeat(this.state, seatIndex);
      if (!player || player.eliminatedAt !== null) continue;

      this.state.table = eliminate(this.state.table!, seatIndex);
      player.eliminatedAt = this.#clock.now();
      player.place = place;
      this.#emit({
        type: 'PLAYER_ELIMINATED',
        playerId: player.playerId,
        seatIndex,
        place,
      });
      place--;
    }
  }

  #beginHand(): void {
    if (this.#disposed || this.state.status !== 'IN_PROGRESS') return;

    const table = this.state.table!;
    if (contestingSeats(table).length < 2) {
      this.#endMatch(livingPlayers(this.state)[0]);
      return;
    }

    this.#advanceBlindLevel();
    this.state.lastResult = null;
    // Bodies carry over between hands; the record of having looked does not.
    // Everybody lifts their cards again, in front of everybody, every hand.
    resetForHand(this.state.presence, this.#clock.now());

    const step = startHand(this.state.table!, this.#rng);
    this.state.table = step.table;
    this.state.phase = 'HAND_IN_PROGRESS';
    for (const event of step.events) this.#emit(event);

    // A hand can be over before anyone acts when every stack is swallowed by
    // the blinds.
    if (this.state.table.status === 'AWAITING_SETTLEMENT') {
      this.#scheduleSettlement();
    } else {
      this.#armActionTimer();
    }
    this.#flush();
  }

  #advanceBlindLevel(): void {
    const elapsedSeconds = elapsedMs(this.state, this.#clock.now()) / 1000;
    const index = levelIndexForElapsed(this.state.structure, elapsedSeconds);
    if (index === this.state.table!.levelIndex) return;

    this.state.table = setLevelIndex(this.state.table!, index);
    const level = levelAt(this.state.structure, index);
    this.#emit({
      type: 'BLIND_LEVEL_UP',
      level: level.level,
      smallBlind: level.smallBlind,
      bigBlind: level.bigBlind,
      ante: level.ante,
    });
  }

  #endMatch(winner: PlayerRecord | undefined): void {
    this.#clock.clearTimeout(this.#timer);
    this.#timer = null;

    // Stop the blind clock so a finished match does not keep climbing levels.
    this.state.clockElapsedMs = elapsedMs(this.state, this.#clock.now());
    this.state.clockRunningSince = null;

    this.state.status = 'FINISHED';
    this.state.phase = 'MATCH_END';
    this.state.actionDeadline = null;

    if (winner) {
      winner.place = 1;
      this.state.winnerPlayerId = winner.playerId;
      this.#emit({ type: 'MATCH_ENDED', winnerPlayerId: winner.playerId });
    }
    this.#flush();
  }

  // -------------------------------------------------------------------------

  #emit(event: MatchEvent): void {
    this.#pendingEvents.push(event);

    // The one place that notices cards and chips physically moving, so his
    // hands can be doing it. Every route into a deal already comes through
    // here, which is why it is the right hook: the alternative was asking the
    // match whether it was mid-deal, and the match is never mid-anything.
    if (MOVED_BY_HIS_HANDS.has(event.type)) {
      this.state.dealer.dealtAt = this.#clock.now();
    }
  }

  /** Hands the batch of events since the last flush to every subscriber. */
  #flush(): void {
    if (this.#pendingEvents.length === 0 && this.#listeners.size === 0) return;
    const events = this.#pendingEvents;
    this.#pendingEvents = [];
    for (const listener of this.#listeners) listener(events);
  }
}
