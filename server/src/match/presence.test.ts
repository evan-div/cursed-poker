import { describe, expect, it } from 'vitest';
import { GAZE_AWAY, PRESENCE, type PresenceFrame, type PresenceInput } from '@cursed/shared';
import {
  createPresence,
  forgetSeat,
  hasPeeked,
  markPeeked,
  projectPresence,
  reportPresence,
  resetForHand,
  type PresenceState,
} from './presence.js';

/**
 * Bodies.
 *
 * Two things are being protected here. The first is that a presence frame is
 * *only* body state — the same audit idea as `projection.test.ts`, applied to
 * the other exit from the server. The second is that going quiet is not a way to
 * hide: a client that stops reporting must still be replicated, and must be
 * replicated as *still*, because stillness is one of the tells the game is made
 * of.
 */

const T0 = 1_000_000;

function input(over: Partial<PresenceInput> = {}): PresenceInput {
  return { gaze: GAZE_AWAY, peek: 0, handlingChips: false, ...over };
}

function frame(presence: PresenceState, now: number, seats = [0, 1, 2, 3]): PresenceFrame {
  return projectPresence(presence, { seatIndices: seats, connected: new Set(seats) }, now);
}

describe('reporting a body', () => {
  it('replicates gaze, peek and chip handling', () => {
    const presence = createPresence();
    reportPresence(
      presence,
      2,
      input({ gaze: { kind: 'SEAT', seatIndex: 4 }, peek: 0.5, handlingChips: true }),
      T0,
    );

    const seat = frame(presence, T0).seats.find((s) => s.seatIndex === 2)!;
    expect(seat.gaze).toEqual({ kind: 'SEAT', seatIndex: 4 });
    expect(seat.peek).toBeCloseTo(0.5, 5);
    expect(seat.handlingChips).toBe(true);
  });

  it('clamps and sanitises whatever a client sends', () => {
    const presence = createPresence();
    for (const [sent, expected] of [
      [5, 1],
      [-3, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
    ] as const) {
      reportPresence(presence, 0, input({ peek: sent }), T0);
      expect(frame(presence, T0).seats[0]!.peek).toBe(expected);
    }
  });

  it('quantises exposure, so measuring an opponent is pointless', () => {
    const presence = createPresence();
    reportPresence(presence, 0, input({ peek: 0.4137 }), T0);
    const peek = frame(presence, T0).seats[0]!.peek;
    expect(peek * 16).toBeCloseTo(Math.round(peek * 16), 6);
  });
});

describe('the rates as a system', () => {
  it('holds a still body at face value for longer than the client stays quiet', () => {
    // A player holding a card perfectly still sends nothing but heartbeats. If
    // decay could start before the next one arrived, every held card at the
    // table would sag and spring back twice a second. It did, once.
    expect(PRESENCE.graceMs).toBeGreaterThan(PRESENCE.heartbeatMs * 2);
  });

  it('drops the cards of a genuinely dead client within a couple of seconds', () => {
    expect(PRESENCE.graceMs + PRESENCE.peekDecayMs).toBeLessThan(3_000);
  });

  it('holds a peek steady across a whole heartbeat interval', () => {
    const presence = createPresence();
    reportPresence(presence, 0, input({ peek: 1 }), T0);
    // Every moment up to the next heartbeat, and a little past it.
    for (let t = 0; t <= PRESENCE.heartbeatMs + 100; t += 25) {
      expect(frame(presence, T0 + t).seats[0]!.peek, `sagged at +${t}ms`).toBe(1);
    }
  });
});

describe('going quiet', () => {
  it('drops the cards of a client that stops reporting', () => {
    const presence = createPresence();
    reportPresence(presence, 1, input({ peek: 1 }), T0);

    // Ordinary gaps between reports do not move it at all.
    expect(frame(presence, T0).seats[1]!.peek).toBe(1);
    expect(frame(presence, T0 + PRESENCE.graceMs).seats[1]!.peek).toBe(1);

    const half = T0 + PRESENCE.graceMs + PRESENCE.peekDecayMs / 2;
    expect(frame(presence, half).seats[1]!.peek).toBeCloseTo(0.5, 1);
    expect(frame(presence, T0 + PRESENCE.graceMs + PRESENCE.peekDecayMs).seats[1]!.peek).toBe(0);
  });

  it('replicates silence as stillness rather than as nothing', () => {
    const presence = createPresence();
    reportPresence(presence, 1, input({ gaze: { kind: 'BOARD' } }), T0);

    const later = frame(presence, T0 + 3_000).seats[1]!;
    expect(later.stillMs).toBe(3_000);
    expect(later.stillMs).toBeGreaterThan(PRESENCE.stillnessMs);
    // The head does not snap back to centre. A frozen stare is a fact about
    // this player, and the table gets to see it.
    expect(later.gaze).toEqual({ kind: 'BOARD' });
  });

  it('does not restart the stillness clock for movement nobody could see', () => {
    const presence = createPresence();
    reportPresence(presence, 0, input({ peek: 0.5 }), T0);
    // Pointer jitter, a thousand times a second, forever.
    for (let i = 1; i <= 20; i++) {
      reportPresence(presence, 0, input({ peek: 0.5 + i * 0.0001 }), T0 + i * 100);
    }
    expect(frame(presence, T0 + 2_000).seats[0]!.stillMs).toBe(2_000);
  });

  it('shows an absent player as an empty chair', () => {
    const presence = createPresence();
    reportPresence(presence, 3, input({ peek: 1, handlingChips: true }), T0);

    const away = projectPresence(
      presence,
      { seatIndices: [0, 1, 2, 3], connected: new Set([0, 1, 2]) },
      T0,
    ).seats.find((s) => s.seatIndex === 3)!;

    expect(away.present).toBe(false);
    expect(away.peek).toBe(0);
    expect(away.handlingChips).toBe(false);
  });

  it('reports a seat that has never said anything at all', () => {
    const seats = frame(createPresence(), T0).seats;
    expect(seats).toHaveLength(4);
    expect(seats.every((s) => s.peek === 0 && s.gaze.kind === 'AWAY')).toBe(true);
  });
});

describe('looking at your own cards', () => {
  it('records the hand it happened in, and only that hand', () => {
    const presence = createPresence();
    expect(markPeeked(presence, 2, 7, T0)).toBe(true);
    // A second look in the same hand is not new information for the projector.
    expect(markPeeked(presence, 2, 7, T0 + 10)).toBe(false);

    expect(hasPeeked(presence, 2, 7)).toBe(true);
    expect(hasPeeked(presence, 2, 8)).toBe(false);
    expect(hasPeeked(presence, 3, 7)).toBe(false);
    expect(hasPeeked(presence, null, 7)).toBe(false);
  });

  it('counts looks and time spent looking, for a system that does not exist yet', () => {
    const presence = createPresence();
    markPeeked(presence, 0, 1, T0);
    markPeeked(presence, 0, 1, T0 + 500);
    reportPresence(presence, 0, input({ peek: 1 }), T0 + 600);
    reportPresence(presence, 0, input({ peek: 1 }), T0 + 1_600);

    const record = presence.find((r) => r.seatIndex === 0)!;
    expect(record.peeksThisHand).toBe(2);
    expect(record.peekMsThisHand).toBe(1_000);

    // And none of it is replicated. Phase 6 reads these; the table never does.
    const seat = frame(presence, T0 + 1_600).seats[0]!;
    expect(Object.keys(seat).sort()).toEqual(
      ['gaze', 'handlingChips', 'peek', 'present', 'seatIndex', 'stillMs'].sort(),
    );
  });

  it('makes everyone look again when a new hand is dealt', () => {
    const presence = createPresence();
    markPeeked(presence, 0, 4, T0);
    markPeeked(presence, 1, 4, T0);
    resetForHand(presence, T0 + 1_000);

    expect(hasPeeked(presence, 0, 4)).toBe(false);
    expect(hasPeeked(presence, 1, 5)).toBe(false);
    expect(presence.find((r) => r.seatIndex === 0)!.peeksThisHand).toBe(0);
  });

  it('keeps the body across hands even though the look does not', () => {
    const presence = createPresence();
    reportPresence(presence, 0, input({ gaze: { kind: 'DEALER' } }), T0);
    resetForHand(presence, T0 + 1_000);
    expect(frame(presence, T0 + 1_000).seats[0]!.gaze).toEqual({ kind: 'DEALER' });
  });
});

describe('the presence frame as a boundary', () => {
  it('carries nothing but body state', () => {
    const presence = createPresence();
    markPeeked(presence, 0, 3, T0);
    reportPresence(
      presence,
      0,
      input({ gaze: { kind: 'OWN_CARDS' }, peek: 0.75, handlingChips: true }),
      T0,
    );

    // Walk the whole frame. Every leaf must be a body fact — no card could
    // hide in here, because there is nowhere for one to be.
    const allowed = new Set([
      'serverTime',
      'seats',
      'seatIndex',
      'gaze',
      'kind',
      'peek',
      'handlingChips',
      'stillMs',
      'present',
    ]);
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          expect(allowed, `unexpected field "${key}" in a presence frame`).toContain(key);
          walk(value);
        }
      }
    };
    walk(frame(presence, T0));
  });

  it('forgets a seat that leaves the lobby', () => {
    const presence = createPresence();
    reportPresence(presence, 1, input({ peek: 1 }), T0);
    forgetSeat(presence, 1);
    expect(presence.find((r) => r.seatIndex === 1)).toBeUndefined();
    expect(frame(presence, T0).seats[1]!.peek).toBe(0);
  });
});
