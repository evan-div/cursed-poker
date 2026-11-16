import { describe, expect, it } from 'vitest';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, parseRoomCode } from './config.js';
import { roomCodeSchema } from './messages.js';

describe('recognising a lobby code', () => {
  it('accepts a code, however it was typed', () => {
    expect(parseRoomCode('ABC234')).toBe('ABC234');
    expect(parseRoomCode('abc234')).toBe('ABC234');
    expect(parseRoomCode('  abc234 ')).toBe('ABC234');
  });

  it('refuses anything that could not be one', () => {
    for (const text of ['', 'ABC23', 'ABC2345', 'ABC10O', 'ABC 34', '<b>x</b>', '../../x', 'ABCDE!']) {
      expect(parseRoomCode(text), text).toBeNull();
    }
  });

  it('agrees with the schema the server validates a code with', () => {
    // Two places decide what a code is: this, for an invitation link, and the
    // schema, for the message that link leads to. They must not drift apart.
    const samples = ['ABC234', 'zzzzzz', 'ABC10O', '234567', 'ABCDEF', 'ABCDE', 'ABCDEFG', 'A-B234', ''];
    for (let i = 0; i < 200; i++) {
      let code = '';
      for (let c = 0; c < ROOM_CODE_LENGTH; c++) code += ROOM_CODE_ALPHABET[(i * 7 + c * 13) % ROOM_CODE_ALPHABET.length];
      samples.push(code);
    }
    for (const text of samples) {
      const parsed = roomCodeSchema.safeParse(text);
      expect(parseRoomCode(text), text).toBe(parsed.success ? parsed.data : null);
    }
  });
});
