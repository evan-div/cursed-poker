import { describe, expect, it } from 'vitest';
import { GAZE_AWAY, type PresenceInput, type StressEvent } from '@cursed/shared';
import { SeededRandomSource } from '../poker/index.js';
import { ManualClock } from './clock.js';
import { Match, type MatchTimings } from './match.js';
import { TRIGGERS } from './stress.js';
import type { StressObserver } from './stress-telemetry.js';

/**
 * The three events about a player's own situation: their clock running out,
 * the Dealer turning to them, and them lifting their cards again.
 *
 * All three existed as names with weights for a whole phase before anything
 * raised them. The telemetry harness is what noticed — see
 * `stress-profile.test.ts`, which now requires every named event to happen in
 * an ordinary evening. These tests pin *when* each one fires.
 */

interface Heard {
  at: number;
  seat: number;
  event: StressEvent;
}

function table(timings: Partial<MatchTimings> = {}) {
  const clock = new ManualClock();
  const heard: Heard[] = [];
  const observer: StressObserver = {
    event: (at, seat, event) => void heard.push({ at, seat, event }),
    settled: () => {},
    forgot: () => {},
  };
  const match = new Match({
    roomCode: 'TRIG',
    hostPlayerId: 'p0',
    clock,
    rng: new SeededRandomSource(5),
    dealerRng: new SeededRandomSource(9),
    timings: {
      actionTimeoutMs: 30_000,
      disconnectedActionTimeoutMs: 5_000,
      showdownDisplayMs: 100,
      foldedHandDisplayMs: 100,
      betweenHandsMs: 100,
      ...timings,
    },
    telemetry: observer,
  });
  const ids = ['p0', 'p1', 'p2', 'p3'];
  for (const id of ids) match.join(id, id);
  for (const id of ids) match.setReady(id, true);
  match.start('p0');

  const of = (event: StressEvent) => heard.filter((h) => h.event === event);
  const wait = (ms: number, step = 100) => {
    for (let t = 0; t < ms; t += step) {
      clock.advance(step);
      match.tick();
    }
  };
  const acting = () => {
    const seat = match.state.table?.hand?.actingSeat ?? null;
    return match.state.players.find((p) => p.seatIndex === seat)!;
  };
  return { match, clock, heard, of, wait, acting };
}

function body(peek: number): PresenceInput {
  return { gaze: GAZE_AWAY, peek, lift: 0, lean: 0, handlingChips: false };
}

describe('CLOCK_LOW', () => {
  it('fires once, for the player whose clock it is, as it runs down', () => {
    const t = table();
    const player = t.acting();
    t.wait(30_000 - TRIGGERS.clockLowMs - 1_000);
    expect(t.of('CLOCK_LOW')).toHaveLength(0);

    t.wait(2_000);
    expect(t.of('CLOCK_LOW')).toEqual([expect.objectContaining({ seat: player.seatIndex })]);

    // Still running down: still once.
    t.wait(TRIGGERS.clockLowMs - 1_500);
    expect(t.of('CLOCK_LOW')).toHaveLength(1);
  });

  it('fires again for the next decision that runs long, and not for a quick one', () => {
    const t = table();
    t.wait(30_000 + 500); // the first player times out
    expect(t.of('CLOCK_LOW')).toHaveLength(1);

    const quick = t.acting();
    t.wait(2_000);
    t.match.submitAction(quick.playerId, t.match.state.table!.hand!.handNumber, { type: 'FOLD' });
    t.wait(2_000);
    expect(t.of('CLOCK_LOW')).toHaveLength(1);

    t.wait(30_000);
    expect(t.of('CLOCK_LOW')).toHaveLength(2);
  });

  it('does not fire for a clock that started shorter than the warning', () => {
    // A disconnected player's clock is a few seconds from the start. Firing
    // the moment it was armed would make the warning meaningless.
    const t = table({ actionTimeoutMs: TRIGGERS.clockLowMs - 1_000 });
    t.wait(20_000);
    expect(t.of('CLOCK_LOW')).toHaveLength(0);
  });
});

describe('RE_CHECKED', () => {
  it('leaves the first look of a hand alone, and counts the second', () => {
    const t = table();
    const player = t.acting();
    const look = () => {
      t.match.reportPresence(player.playerId, body(0.9));
      t.wait(500);
      t.match.reportPresence(player.playerId, body(0));
      t.wait(500);
    };

    look();
    expect(t.of('RE_CHECKED')).toHaveLength(0);
    t.wait(TRIGGERS.recheckCooldownMs);
    look();
    expect(t.of('RE_CHECKED')).toEqual([expect.objectContaining({ seat: player.seatIndex })]);
  });

  it('feels a burst of fidgeting once, though the table saw all of it', () => {
    const t = table();
    const player = t.acting();
    for (let i = 0; i < 8; i++) {
      t.match.reportPresence(player.playerId, body(0.9));
      t.wait(200);
      t.match.reportPresence(player.playerId, body(0));
      t.wait(200);
    }
    // Eight looks in three seconds: one free, then one counted, then cooldown.
    expect(t.of('RE_CHECKED')).toHaveLength(1);
    expect(t.match.state.presence.find((r) => r.seatIndex === player.seatIndex)!.looksThisHand).toBe(8);
  });

  it('does not count looking at cards you have already thrown away', () => {
    const t = table();
    const player = t.acting();
    t.match.submitAction(player.playerId, t.match.state.table!.hand!.handNumber, { type: 'FOLD' });
    for (let i = 0; i < 3; i++) {
      t.match.reportPresence(player.playerId, body(0.9));
      t.wait(TRIGGERS.recheckCooldownMs);
      t.match.reportPresence(player.playerId, body(0));
      t.wait(500);
    }
    expect(t.of('RE_CHECKED')).toHaveLength(0);
  });
});

describe('WATCHED', () => {
  it('jolts whoever the Dealer has just turned to, and nobody else', () => {
    const t = table();
    const turns: { at: number; seat: number }[] = [];
    let previous: number | null = null;

    for (let i = 0; i < 3_000; i++) {
      t.clock.advance(83);
      t.match.tick();
      const gaze = t.match.state.dealer.gaze;
      const seat = gaze.kind === 'SEAT' ? gaze.seatIndex : null;
      if (seat !== previous && seat !== null) turns.push({ at: t.clock.now(), seat });
      previous = seat;
    }

    const watched = t.of('WATCHED');
    expect(watched.length, 'he never looked at anybody').toBeGreaterThan(0);
    // Every jolt is on a tick where he turned to that seat.
    for (const jolt of watched) {
      expect(turns).toContainEqual({ at: jolt.at, seat: jolt.seat });
    }
    // And at most once per cooldown per seat, however often he flicks back.
    for (const seat of [0, 1, 2, 3]) {
      const times = watched.filter((w) => w.seat === seat).map((w) => w.at);
      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(TRIGGERS.watchedCooldownMs);
      }
    }
  });

  it('jolts once per stare, however often he flicks back', () => {
    // Steered by hand: his gaze only changes when he next decides, so holding
    // that off and turning his head directly is the deterministic way to make
    // him flick between two seats faster than he would on his own.
    const t = table();
    const dealer = t.match.state.dealer;
    const turnTo = (seat: number) => {
      dealer.nextDecisionAt = t.clock.now() + 1_000_000;
      dealer.gaze = { kind: 'SEAT', seatIndex: seat };
      t.clock.advance(500);
      t.match.tick();
    };

    for (let i = 0; i < 6; i++) turnTo(i % 2 === 0 ? 1 : 2);
    expect(t.of('WATCHED').filter((w) => w.seat === 1)).toHaveLength(1);
    expect(t.of('WATCHED').filter((w) => w.seat === 2)).toHaveLength(1);

    t.wait(TRIGGERS.watchedCooldownMs);
    turnTo(1);
    expect(t.of('WATCHED').filter((w) => w.seat === 1)).toHaveLength(2);
  });
});
