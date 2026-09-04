/**
 * The wire protocol.
 *
 * Every message a client can send is defined here *with a runtime schema*, not
 * just a type. Types vanish at compile time; a client is an untrusted process
 * and can send whatever it likes, so the server parses every inbound payload
 * through these schemas before it reaches any game code.
 *
 * Server-to-client messages carry no schema because they are not a trust
 * boundary — the client is free to believe the server.
 */
import { z } from 'zod';
import type { ClientView } from './view.js';
import type { HandEvent } from './hand-events.js';
import { MAX_PLAYERS } from './config.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Lobby code alphabet, chosen to survive being read aloud: no 0/O, no 1/I/L.
 * 31^6 is about 887 million codes, which with join rate limiting is enough that
 * guessing a live lobby is not a practical attack.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 6;

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(ROOM_CODE_LENGTH)
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]+$`), 'Not a valid lobby code');

export const DISPLAY_NAME_MAX = 20;

export const displayNameSchema = z
  .string()
  .transform((s) => s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim())
  .pipe(z.string().min(1, 'Name cannot be empty').max(DISPLAY_NAME_MAX));

export const sessionTokenSchema = z.string().min(16).max(512);

export const playerActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('FOLD') }),
  z.object({ type: z.literal('CHECK') }),
  z.object({ type: z.literal('CALL') }),
  z.object({ type: z.literal('ALL_IN') }),
  z.object({ type: z.literal('BET'), to: z.number().int().nonnegative() }),
  z.object({ type: z.literal('RAISE'), to: z.number().int().nonnegative() }),
]);

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const createLobbySchema = z.object({ displayName: displayNameSchema });

export const joinLobbySchema = z.object({
  code: roomCodeSchema,
  displayName: displayNameSchema,
});

export const resumeSessionSchema = z.object({ token: sessionTokenSchema });

export const setReadySchema = z.object({ ready: z.boolean() });

export const startMatchSchema = z.object({});

/**
 * `handNumber` makes the action idempotent against the hand it was decided in.
 * Without it a laggy client can fold a hand that already ended and have the
 * fold land on the next one.
 */
export const submitActionSchema = z.object({
  handNumber: z.number().int().positive(),
  action: playerActionSchema,
});

export type CreateLobbyPayload = z.infer<typeof createLobbySchema>;
export type JoinLobbyPayload = z.infer<typeof joinLobbySchema>;
export type ResumeSessionPayload = z.infer<typeof resumeSessionSchema>;
export type SetReadyPayload = z.infer<typeof setReadySchema>;
export type StartMatchPayload = z.infer<typeof startMatchSchema>;
export type SubmitActionPayload = z.infer<typeof submitActionSchema>;

/** Every inbound message name, paired with the schema that validates it. */
export const CLIENT_MESSAGE_SCHEMAS = {
  'lobby:create': createLobbySchema,
  'lobby:join': joinLobbySchema,
  'lobby:resume': resumeSessionSchema,
  'lobby:ready': setReadySchema,
  'lobby:start': startMatchSchema,
  'poker:action': submitActionSchema,
} as const;

export type ClientMessageName = keyof typeof CLIENT_MESSAGE_SCHEMAS;

export type ClientMessage = {
  [K in ClientMessageName]: {
    name: K;
    payload: z.infer<(typeof CLIENT_MESSAGE_SCHEMAS)[K]>;
  };
}[ClientMessageName];

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'BAD_REQUEST',
  'NOT_FOUND',
  'ROOM_FULL',
  'ALREADY_STARTED',
  'NOT_HOST',
  'NOT_ENOUGH_PLAYERS',
  'NOT_YOUR_TURN',
  'ILLEGAL_ACTION',
  'STALE_HAND',
  'RATE_LIMITED',
  'SESSION_INVALID',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SessionGrant {
  /** Opaque to the client. Proves identity on reconnect; treat as a secret. */
  token: string;
  playerId: string;
  roomCode: string;
}

export type Ack<T> = ({ ok: true } & T) | { ok: false; code: ErrorCode; message: string };

export type JoinAck = Ack<SessionGrant>;
export type SimpleAck = Ack<Record<string, never>>;

/**
 * Match-level narration. Poker's own events arrive as `HandEvent`; these cover
 * everything that happens around a hand rather than inside one.
 */
export type LobbyEvent =
  | { type: 'PLAYER_JOINED'; playerId: string; displayName: string; seatIndex: number }
  | { type: 'PLAYER_LEFT'; playerId: string }
  | { type: 'PLAYER_CONNECTION'; playerId: string; connected: boolean }
  | { type: 'MATCH_STARTED'; seatCount: number }
  | { type: 'BLIND_LEVEL_UP'; level: number; smallBlind: number; bigBlind: number; ante: number }
  | { type: 'PLAYER_TIMED_OUT'; seatIndex: number; forcedFold: boolean }
  | { type: 'PLAYER_ELIMINATED'; playerId: string; seatIndex: number; place: number }
  | { type: 'MATCH_ENDED'; winnerPlayerId: string };

export type MatchEvent = HandEvent | LobbyEvent;

export interface ServerMessages {
  /** The authoritative view. Sent whole on every change; see docs/ARCHITECTURE. */
  view: (view: ClientView) => void;
  /** Narration for animation and the log. Never a source of truth. */
  events: (events: MatchEvent[]) => void;
  error: (error: { code: ErrorCode; message: string }) => void;
}

export const MAX_SEATS = MAX_PLAYERS;
