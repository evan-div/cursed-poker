import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Session tokens.
 *
 * A token is the *only* thing proving a reconnecting player is who they say they
 * are — and whoever holds it holds that seat's hole cards. So it is signed,
 * unguessable, bound to one room, and expires. It is never a seat index, a
 * player name, or anything else a stranger could construct.
 *
 * Format: `base64url(payload).base64url(hmac-sha256(payload))`
 */

export interface SessionData {
  playerId: string;
  roomCode: string;
  issuedAt: number;
}

interface TokenPayload {
  p: string;
  r: string;
  t: number;
  /** Random nonce so two tokens for the same player are never identical. */
  n: string;
}

const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export class SessionManager {
  readonly #secret: Buffer;
  readonly #maxAgeMs: number;

  constructor(options: { secret?: Buffer | string; maxAgeMs?: number } = {}) {
    const secret = options.secret ?? randomBytes(32);
    this.#secret = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
    if (this.#secret.length < 16) {
      throw new Error('Session secret must be at least 16 bytes');
    }
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  issue(roomCode: string, playerId: string, now = Date.now()): string {
    const payload: TokenPayload = {
      p: playerId,
      r: roomCode,
      t: now,
      n: randomBytes(9).toString('base64url'),
    };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${encoded}.${this.#sign(encoded)}`;
  }

  /** Returns null for anything that is not a valid, unexpired token we issued. */
  verify(token: string, now = Date.now()): SessionData | null {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;

    const encoded = token.slice(0, dot);
    const signature = token.slice(dot + 1);

    const expected = Buffer.from(this.#sign(encoded), 'utf8');
    const actual = Buffer.from(signature, 'utf8');
    // Length must match before timingSafeEqual, and comparing lengths first
    // leaks nothing an attacker cannot already see.
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    let payload: TokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload;
    } catch {
      return null;
    }
    if (typeof payload.p !== 'string' || typeof payload.r !== 'string') return null;
    if (typeof payload.t !== 'number' || !Number.isFinite(payload.t)) return null;
    if (now - payload.t > this.#maxAgeMs) return null;

    return { playerId: payload.p, roomCode: payload.r, issuedAt: payload.t };
  }

  #sign(encoded: string): string {
    return createHmac('sha256', this.#secret).update(encoded).digest('base64url');
  }
}

/** A fresh, unguessable player id. Never derived from a name or a seat. */
export function newPlayerId(): string {
  return randomBytes(12).toString('base64url');
}
