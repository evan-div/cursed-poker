import { randomInt } from 'node:crypto';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, type BlindStructure } from '@cursed/shared';
import { Match, type MatchTimings } from '../match/match.js';
import type { Clock } from '../match/clock.js';
import type { RandomSource } from '../poker/index.js';

/**
 * Lobbies.
 *
 * Rooms are held in memory: a match is a single 60-90 minute session between
 * friends, and there is nothing worth persisting across a server restart yet.
 * `MatchState` is plain JSON on purpose, so snapshotting is a small change when
 * that stops being true.
 */

export interface RoomManagerOptions {
  clock: Clock;
  rng?: RandomSource;
  structure?: BlindStructure;
  timings?: Partial<MatchTimings>;
  /** How long an empty room lingers before it is swept away. */
  emptyRoomTtlMs?: number;
}

export interface Room {
  code: string;
  match: Match;
  createdAt: number;
  /** When the room last had a connected player, for sweeping. */
  lastOccupiedAt: number;
}

const DEFAULT_EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

export class RoomManager {
  readonly #rooms = new Map<string, Room>();
  readonly #options: RoomManagerOptions;
  readonly #emptyRoomTtlMs: number;

  constructor(options: RoomManagerOptions) {
    this.#options = options;
    this.#emptyRoomTtlMs = options.emptyRoomTtlMs ?? DEFAULT_EMPTY_ROOM_TTL_MS;
  }

  create(hostPlayerId: string): Room {
    const code = this.#allocateCode();
    const match = new Match({
      roomCode: code,
      hostPlayerId,
      clock: this.#options.clock,
      ...(this.#options.rng ? { rng: this.#options.rng } : {}),
      ...(this.#options.structure ? { structure: this.#options.structure } : {}),
      ...(this.#options.timings ? { timings: this.#options.timings } : {}),
    });

    const now = this.#options.clock.now();
    const room: Room = { code, match, createdAt: now, lastOccupiedAt: now };
    this.#rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.#rooms.get(code.toUpperCase());
  }

  touch(code: string): void {
    const room = this.#rooms.get(code);
    if (room) room.lastOccupiedAt = this.#options.clock.now();
  }

  remove(code: string): void {
    const room = this.#rooms.get(code);
    if (!room) return;
    room.match.dispose();
    this.#rooms.delete(code);
  }

  /** Drops rooms nobody has been connected to for a while. */
  sweep(): number {
    const now = this.#options.clock.now();
    let removed = 0;
    for (const room of [...this.#rooms.values()]) {
      const occupied = room.match.state.players.some((p) => p.connected);
      if (occupied) {
        room.lastOccupiedAt = now;
        continue;
      }
      if (now - room.lastOccupiedAt > this.#emptyRoomTtlMs) {
        this.remove(room.code);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#rooms.size;
  }

  #allocateCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = generateRoomCode();
      if (!this.#rooms.has(code)) return code;
    }
    throw new Error('Could not allocate a free lobby code');
  }
}

/** Uses the CSPRNG: a predictable lobby code is a way into a private game. */
export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}
