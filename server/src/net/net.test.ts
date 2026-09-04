import { describe, expect, it } from 'vitest';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@cursed/shared';
import { ManualClock } from '../match/clock.js';
import { RateLimiter } from './rate-limit.js';
import { RoomManager, generateRoomCode } from './rooms.js';
import { SessionManager, newPlayerId } from './sessions.js';

describe('session tokens', () => {
  const sessions = new SessionManager({ secret: 'a-secret-long-enough-for-tests' });

  it('round-trips the room and player it was issued for', () => {
    const token = sessions.issue('ABCDEF', 'player-1', 1_000);
    expect(sessions.verify(token, 1_000)).toEqual({
      playerId: 'player-1',
      roomCode: 'ABCDEF',
      issuedAt: 1_000,
    });
  });

  it('issues a different token every time', () => {
    const a = sessions.issue('ABCDEF', 'player-1');
    const b = sessions.issue('ABCDEF', 'player-1');
    expect(a).not.toBe(b);
    expect(sessions.verify(a)?.playerId).toBe('player-1');
    expect(sessions.verify(b)?.playerId).toBe('player-1');
  });

  it('rejects a tampered payload', () => {
    const token = sessions.issue('ABCDEF', 'victim');
    const [payload, signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ p: 'attacker', r: 'ABCDEF', t: Date.now(), n: 'x' }),
      'utf8',
    ).toString('base64url');
    expect(sessions.verify(`${forgedPayload}.${signature}`)).toBeNull();
    expect(sessions.verify(`${payload}.${signature!.slice(0, -2)}zz`)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const other = new SessionManager({ secret: 'a-completely-different-secret!!' });
    expect(sessions.verify(other.issue('ABCDEF', 'player-1'))).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    for (const junk of ['', '.', 'nodot', 'a.', '.b', '{}', 'a'.repeat(500)]) {
      expect(sessions.verify(junk)).toBeNull();
    }
  });

  it('expires old tokens', () => {
    const shortLived = new SessionManager({ secret: 'x'.repeat(32), maxAgeMs: 1_000 });
    const token = shortLived.issue('ABCDEF', 'player-1', 0);
    expect(shortLived.verify(token, 900)).not.toBeNull();
    expect(shortLived.verify(token, 1_001)).toBeNull();
  });

  it('refuses a weak secret', () => {
    expect(() => new SessionManager({ secret: 'short' })).toThrow(/at least 16 bytes/);
  });

  it('mints unguessable player ids', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => newPlayerId()));
    expect(ids.size).toBe(1_000);
    expect([...ids][0]!.length).toBeGreaterThanOrEqual(16);
  });
});

describe('rate limiting', () => {
  it('allows a burst then throttles', () => {
    const clock = new ManualClock();
    const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 1, now: () => clock.now() });

    for (let i = 0; i < 5; i++) expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);

    clock.advance(2_000);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
  });

  it('keeps buckets separate per key', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
    expect(limiter.tryConsume('b')).toBe(true);
  });

  it('never refills past capacity', () => {
    const clock = new ManualClock();
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 10, now: () => clock.now() });
    clock.advance(60_000);
    for (let i = 0; i < 3; i++) expect(limiter.tryConsume('a')).toBe(true);
    expect(limiter.tryConsume('a')).toBe(false);
  });

  it('sweeps buckets that have fully refilled', () => {
    const clock = new ManualClock();
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: () => clock.now() });
    limiter.tryConsume('a');
    expect(limiter.size).toBe(1);
    limiter.sweep();
    expect(limiter.size).toBe(1);
    clock.advance(10_000);
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });
});

describe('lobby codes', () => {
  it('uses only the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      for (const char of code) expect(ROOM_CODE_ALPHABET).toContain(char);
    }
  });

  it('does not repeat itself in any practical sample', () => {
    const codes = new Set(Array.from({ length: 5_000 }, () => generateRoomCode()));
    // 31^6 codes; a handful of collisions in 5,000 draws would mean broken entropy.
    expect(codes.size).toBeGreaterThan(4_995);
  });
});

describe('rooms', () => {
  it('creates, finds and removes rooms case-insensitively', () => {
    const clock = new ManualClock();
    const rooms = new RoomManager({ clock });
    const room = rooms.create('host-1');

    expect(rooms.get(room.code)).toBe(room);
    expect(rooms.get(room.code.toLowerCase())).toBe(room);
    expect(rooms.size).toBe(1);

    rooms.remove(room.code);
    expect(rooms.get(room.code)).toBeUndefined();
    expect(rooms.size).toBe(0);
  });

  it('sweeps away rooms nobody has connected to', () => {
    const clock = new ManualClock();
    const rooms = new RoomManager({ clock, emptyRoomTtlMs: 1_000 });
    const room = rooms.create('host-1');
    room.match.join('host-1', 'Host');

    clock.advance(2_000);
    expect(rooms.sweep()).toBe(0); // the host is still connected

    room.match.setConnected('host-1', false);
    expect(rooms.sweep()).toBe(0); // lastOccupiedAt was just refreshed
    clock.advance(2_000);
    expect(rooms.sweep()).toBe(1);
    expect(rooms.size).toBe(0);
  });
});
