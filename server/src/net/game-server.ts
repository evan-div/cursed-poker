import {
  CLIENT_MESSAGE_SCHEMAS,
  PRESENCE,
  PRESENCE_MESSAGES,
  type BlindStructure,
  type ClientMessageName,
  type ErrorCode,
  type MatchEvent,
  type PresenceInput,
} from '@cursed/shared';
import { MatchError, type MatchTimings } from '../match/match.js';
import { SystemClock, type Clock, type TimerHandle } from '../match/clock.js';
import type { RandomSource } from '../poker/index.js';
import { RateLimiter } from './rate-limit.js';
import { RoomManager, type Room } from './rooms.js';
import { SessionManager, newPlayerId } from './sessions.js';
import type { AckFn, Connection, Transport } from './transport.js';

/**
 * Wires transport, sessions, rooms and matches together.
 *
 * Its one job at the trust boundary: nothing reaches game code without passing
 * a schema first, and nothing leaves toward a client except a projected view.
 * Every inbound payload is parsed, every action is re-validated by the engine,
 * and every outbound view is built per player.
 */

export interface GameServerOptions {
  transport: Transport;
  clock?: Clock;
  sessionSecret?: string | Buffer;
  structure?: BlindStructure;
  rng?: RandomSource;
  timings?: Partial<MatchTimings>;
  /** Sustained messages per second per connection, with a burst allowance. */
  messagesPerSecond?: number;
  /** Lobby create/join attempts allowed per address per minute. */
  joinsPerMinute?: number;
  /**
   * Body reports allowed per second per connection.
   *
   * Metered separately from everything else. Presence arrives fifteen times a
   * second by design, and if it shared a bucket with poker actions then turning
   * your head would eat the budget you need to fold.
   */
  presencePerSecond?: number;
  /** How often the table's bodies are broadcast. Zero disables the tick. */
  presenceHz?: number;
}

interface ConnectionState {
  connection: Connection;
  roomCode: string | null;
  playerId: string | null;
}

export class GameServer {
  readonly rooms: RoomManager;
  readonly sessions: SessionManager;

  readonly #clock: Clock;
  readonly #transport: Transport;
  readonly #states = new Map<string, ConnectionState>();
  /** roomCode -> playerId -> the connection currently speaking for that player. */
  readonly #roomSockets = new Map<string, Map<string, Connection>>();
  readonly #unsubscribes = new Map<string, () => void>();
  readonly #messageLimiter: RateLimiter;
  readonly #joinLimiter: RateLimiter;
  readonly #presenceLimiter: RateLimiter;
  readonly #presenceIntervalMs: number;
  #presenceTimer: TimerHandle | null = null;

  constructor(options: GameServerOptions) {
    this.#clock = options.clock ?? new SystemClock();
    this.#transport = options.transport;
    this.sessions = new SessionManager(
      options.sessionSecret ? { secret: options.sessionSecret } : {},
    );
    this.rooms = new RoomManager({
      clock: this.#clock,
      ...(options.rng ? { rng: options.rng } : {}),
      ...(options.structure ? { structure: options.structure } : {}),
      ...(options.timings ? { timings: options.timings } : {}),
    });

    const perSecond = options.messagesPerSecond ?? 20;
    this.#messageLimiter = new RateLimiter({
      capacity: perSecond * 2,
      refillPerSecond: perSecond,
      now: () => this.#clock.now(),
    });
    const joinsPerMinute = options.joinsPerMinute ?? 12;
    this.#joinLimiter = new RateLimiter({
      capacity: joinsPerMinute,
      refillPerSecond: joinsPerMinute / 60,
      now: () => this.#clock.now(),
    });

    // Headroom over the client's own send rate, so a burst after a stall is
    // absorbed rather than dropped, but still a hard ceiling.
    const presencePerSecond = options.presencePerSecond ?? PRESENCE.clientHz + 5;
    this.#presenceLimiter = new RateLimiter({
      capacity: presencePerSecond * 2,
      refillPerSecond: presencePerSecond,
      now: () => this.#clock.now(),
    });

    const presenceHz = options.presenceHz ?? PRESENCE.broadcastHz;
    this.#presenceIntervalMs = presenceHz > 0 ? Math.round(1000 / presenceHz) : 0;

    this.#transport.onConnection((connection) => this.#onConnection(connection));
  }

  async close(): Promise<void> {
    this.#clock.clearTimeout(this.#presenceTimer);
    this.#presenceTimer = null;
    for (const unsubscribe of this.#unsubscribes.values()) unsubscribe();
    this.#unsubscribes.clear();
    for (const state of this.#states.values()) state.connection.close();
    this.#states.clear();
    this.#roomSockets.clear();
    await this.#transport.close();
  }

  /** Housekeeping: drop abandoned rooms and stale rate-limit buckets. */
  sweep(): void {
    const removed = this.rooms.sweep();
    if (removed > 0) {
      for (const [code, sockets] of this.#roomSockets) {
        if (!this.rooms.get(code)) {
          for (const connection of sockets.values()) connection.close();
          this.#roomSockets.delete(code);
          this.#unsubscribes.get(code)?.();
          this.#unsubscribes.delete(code);
        }
      }
    }
    this.#messageLimiter.sweep();
    this.#joinLimiter.sweep();
    this.#presenceLimiter.sweep();
  }

  // -------------------------------------------------------------------------

  #onConnection(connection: Connection): void {
    const state: ConnectionState = { connection, roomCode: null, playerId: null };
    this.#states.set(connection.id, state);

    connection.onMessage((name, payload, ack) => {
      try {
        this.#handle(state, name, payload, ack);
      } catch (error) {
        this.#fail(state, ack, toErrorCode(error), (error as Error).message);
      }
    });

    connection.onClose(() => this.#onClose(state));
  }

  #handle(state: ConnectionState, name: string, payload: unknown, ack?: AckFn): void {
    if (!isClientMessage(name)) {
      return this.#fail(state, ack, 'BAD_REQUEST', `Unknown message "${name}"`);
    }
    // Bodies and decisions are metered separately; see `presencePerSecond`.
    const isPresence = PRESENCE_MESSAGES.has(name);
    const limiter = isPresence ? this.#presenceLimiter : this.#messageLimiter;

    // A body report is sent unacknowledged fifteen times a second. Rejecting one
    // out loud would put an error banner on a player's screen for turning their
    // head, so an unacknowledged presence failure is simply dropped — the next
    // report is 66ms away and will say the same thing.
    const quiet = isPresence && !ack;

    if (!limiter.tryConsume(state.connection.id)) {
      if (quiet) return;
      return this.#fail(state, ack, 'RATE_LIMITED', 'Slow down');
    }

    // Untrusted input stops here: nothing below sees an unparsed payload.
    const parsed = CLIENT_MESSAGE_SCHEMAS[name].safeParse(payload ?? {});
    if (!parsed.success) {
      if (quiet) return;
      const issue = parsed.error.issues[0];
      return this.#fail(
        state,
        ack,
        'BAD_REQUEST',
        issue ? `${issue.path.join('.') || 'payload'}: ${issue.message}` : 'Invalid payload',
      );
    }

    switch (name) {
      case 'lobby:create':
        return this.#createLobby(state, parsed.data as { displayName: string }, ack);
      case 'lobby:join':
        return this.#joinLobby(state, parsed.data as { code: string; displayName: string }, ack);
      case 'lobby:resume':
        return this.#resume(state, parsed.data as { token: string }, ack);
      case 'lobby:ready':
        return this.#setReady(state, parsed.data as { ready: boolean }, ack);
      case 'lobby:start':
        return this.#start(state, ack);
      case 'poker:action':
        return this.#action(state, parsed.data as { handNumber: number; action: never }, ack);
      case 'poker:peek':
        return this.#peek(state, parsed.data as { handNumber: number }, ack);
      case 'player:presence':
        return this.#presence(state, parsed.data as PresenceInput, ack);
    }
  }

  #createLobby(state: ConnectionState, payload: { displayName: string }, ack?: AckFn): void {
    if (!this.#joinLimiter.tryConsume(state.connection.remoteAddress)) {
      return this.#fail(state, ack, 'RATE_LIMITED', 'Too many lobbies from this address');
    }

    const playerId = newPlayerId();
    const room = this.rooms.create(playerId);
    this.#watch(room);
    room.match.join(playerId, payload.displayName);
    this.#attach(state, room, playerId);
    this.#grant(ack, room.code, playerId);
  }

  #joinLobby(
    state: ConnectionState,
    payload: { code: string; displayName: string },
    ack?: AckFn,
  ): void {
    // Throttled per address, because this is the lobby-code guessing surface.
    if (!this.#joinLimiter.tryConsume(state.connection.remoteAddress)) {
      return this.#fail(state, ack, 'RATE_LIMITED', 'Too many join attempts');
    }

    const room = this.rooms.get(payload.code);
    if (!room) return this.#fail(state, ack, 'NOT_FOUND', 'No lobby with that code');

    const playerId = newPlayerId();
    this.#watch(room);
    room.match.join(playerId, payload.displayName);
    this.#attach(state, room, playerId);
    this.#grant(ack, room.code, playerId);
  }

  #resume(state: ConnectionState, payload: { token: string }, ack?: AckFn): void {
    const session = this.sessions.verify(payload.token, this.#clock.now());
    if (!session) return this.#fail(state, ack, 'SESSION_INVALID', 'That session has expired');

    const room = this.rooms.get(session.roomCode);
    if (!room) return this.#fail(state, ack, 'NOT_FOUND', 'That lobby is gone');
    if (!room.match.state.players.some((p) => p.playerId === session.playerId)) {
      return this.#fail(state, ack, 'SESSION_INVALID', 'You are no longer in that lobby');
    }

    this.#watch(room);
    this.#attach(state, room, session.playerId);
    this.#grant(ack, room.code, session.playerId);
  }

  #setReady(state: ConnectionState, payload: { ready: boolean }, ack?: AckFn): void {
    const { room, playerId } = this.#require(state);
    room.match.setReady(playerId, payload.ready);
    this.#ok(ack);
  }

  #start(state: ConnectionState, ack?: AckFn): void {
    const { room, playerId } = this.#require(state);
    room.match.start(playerId);
    this.#ok(ack);
  }

  #action(
    state: ConnectionState,
    payload: { handNumber: number; action: never },
    ack?: AckFn,
  ): void {
    const { room, playerId } = this.#require(state);
    room.match.submitAction(playerId, payload.handNumber, payload.action);
    this.#ok(ack);
  }

  #peek(state: ConnectionState, payload: { handNumber: number }, ack?: AckFn): void {
    const { room, playerId } = this.#require(state);
    // The cards are not in this reply. Marking the seat as having looked causes
    // the match to push a fresh view, and the view is where the cards live.
    room.match.peek(playerId, payload.handNumber);
    this.#ok(ack);
  }

  #presence(state: ConnectionState, payload: PresenceInput, ack?: AckFn): void {
    // Silently ignored outside a room: a body report is not worth an error, and
    // a client that has not joined yet has nothing to report about.
    if (state.roomCode && state.playerId) {
      const room = this.rooms.get(state.roomCode);
      room?.match.reportPresence(state.playerId, payload);
    }
    this.#ok(ack);
  }

  // -------------------------------------------------------------------------

  #require(state: ConnectionState): { room: Room; playerId: string } {
    if (!state.roomCode || !state.playerId) {
      throw new MatchError('NOT_FOUND', 'You are not in a lobby');
    }
    const room = this.rooms.get(state.roomCode);
    if (!room) throw new MatchError('NOT_FOUND', 'That lobby is gone');
    return { room, playerId: state.playerId };
  }

  /** Points a connection at a player, replacing any older one for that seat. */
  #attach(state: ConnectionState, room: Room, playerId: string): void {
    const sockets = this.#roomSockets.get(room.code) ?? new Map<string, Connection>();
    this.#roomSockets.set(room.code, sockets);

    const previous = sockets.get(playerId);
    if (previous && previous.id !== state.connection.id) {
      // The newest connection speaks for the player. Detach the old one first so
      // its close handler cannot mark the player disconnected afterwards.
      const previousState = this.#states.get(previous.id);
      if (previousState) {
        previousState.roomCode = null;
        previousState.playerId = null;
      }
      previous.close();
    }

    sockets.set(playerId, state.connection);
    state.roomCode = room.code;
    state.playerId = playerId;

    room.match.setConnected(playerId, true);
    this.rooms.touch(room.code);
    this.#push(room, [], playerId);
    this.#startPresenceTick();
  }

  /**
   * Broadcasts every occupied table's bodies on a fixed tick.
   *
   * Separate from the view push on purpose: presence changes fifteen times a
   * second and a full view for six players does not. One frame, sent to
   * everybody, because presence has no per-viewer half.
   */
  #startPresenceTick(): void {
    if (this.#presenceTimer || this.#presenceIntervalMs <= 0) return;

    const tick = () => {
      this.#presenceTimer = null;
      let talkedToAnyone = false;

      for (const [code, sockets] of this.#roomSockets) {
        const room = this.rooms.get(code);
        if (!room || sockets.size === 0) continue;
        const frame = room.match.presenceFor();
        for (const connection of sockets.values()) connection.send('presence', frame);
        talkedToAnyone = true;
      }

      // Nobody is listening. Stop rather than ticking twelve times a second at
      // an empty process; `#attach` starts it again when somebody sits down.
      if (!talkedToAnyone) return;
      this.#presenceTimer = this.#clock.setTimeout(tick, this.#presenceIntervalMs);
    };

    this.#presenceTimer = this.#clock.setTimeout(tick, this.#presenceIntervalMs);
  }

  #onClose(state: ConnectionState): void {
    this.#states.delete(state.connection.id);
    this.#messageLimiter.forget(state.connection.id);

    if (!state.roomCode || !state.playerId) return;
    const sockets = this.#roomSockets.get(state.roomCode);
    if (sockets?.get(state.playerId)?.id === state.connection.id) {
      sockets.delete(state.playerId);
    }

    const room = this.rooms.get(state.roomCode);
    if (!room) return;

    // Before the match starts a departure is a departure; after it, the seat and
    // its chips stay put and the player is simply gone for a while.
    if (room.match.state.status === 'LOBBY') room.match.leave(state.playerId);
    else room.match.setConnected(state.playerId, false);
  }

  /** One subscription per room, pushing a freshly projected view to each player. */
  #watch(room: Room): void {
    if (this.#unsubscribes.has(room.code)) return;
    this.#unsubscribes.set(
      room.code,
      room.match.onUpdate((events) => this.#push(room, events)),
    );
  }

  #push(room: Room, events: MatchEvent[], onlyPlayerId?: string): void {
    const sockets = this.#roomSockets.get(room.code);
    if (!sockets) return;

    for (const [playerId, connection] of sockets) {
      if (onlyPlayerId && playerId !== onlyPlayerId) continue;
      // The one place match state becomes bytes: always per player, always
      // through the projection.
      connection.send('view', room.match.viewFor(playerId));
      if (events.length > 0) connection.send('events', events);
    }
  }

  #grant(ack: AckFn | undefined, roomCode: string, playerId: string): void {
    const token = this.sessions.issue(roomCode, playerId, this.#clock.now());
    ack?.({ ok: true, token, playerId, roomCode });
  }

  #ok(ack?: AckFn): void {
    ack?.({ ok: true });
  }

  #fail(state: ConnectionState, ack: AckFn | undefined, code: ErrorCode, message: string): void {
    if (ack) ack({ ok: false, code, message });
    else state.connection.send('error', { code, message });
  }
}

function isClientMessage(name: string): name is ClientMessageName {
  return Object.hasOwn(CLIENT_MESSAGE_SCHEMAS, name);
}

function toErrorCode(error: unknown): ErrorCode {
  if (error instanceof MatchError) return error.code;
  return 'INTERNAL';
}
