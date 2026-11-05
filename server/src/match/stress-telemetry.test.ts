import { describe, expect, it } from 'vitest';
import { STRESS_EVENTS } from '@cursed/shared';
import { ManualClock } from './clock.js';
import { Match } from './match.js';
import { playEvening } from './simulate.js';
import { DEFAULT_TUNING } from './stress.js';
import {
  StressRecorder,
  formatSummary,
  replayStress,
  summariseStress,
  type StressLog,
} from './stress-telemetry.js';

/**
 * The tuning instrument.
 *
 * Three promises: a recording holds nothing but the model's own public inputs;
 * replaying it under the same tuning gives back exactly what the players felt;
 * and replaying it under a different tuning actually changes the answer — an
 * instrument that cannot tell two tunings apart is not one.
 */

function recordEvening(players = 4, seed = 31_337): { log: StressLog; ticks: number } {
  const recorder = new StressRecorder({ tuning: DEFAULT_TUNING });
  let ticks = 0;
  playEvening({ players, seed, telemetry: recorder, onTick: () => ticks++ });
  return { log: recorder.log, ticks };
}

const evening = recordEvening();

describe('what a recording may contain', () => {
  it('is a version, a tuning, a sample rate and a list of entries, and nothing else', () => {
    expect(Object.keys(evening.log).sort()).toEqual(['entries', 'sampleEveryMs', 'tuning', 'version']);
    expect(evening.log.entries.length).toBeGreaterThan(100);
  });

  it('holds every entry to a fixed shape of numbers and one event name', () => {
    // An allowlist on shape rather than a search for card-like strings: a card
    // could be encoded a dozen ways, but there is no way to encode one in a
    // tuple whose every field is a finite number, a 0/1 flag, or a name from
    // `STRESS_EVENTS`. Adding a field here should fail this test first, and
    // be argued for here.
    const isTime = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    const isSeat = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 10;
    const isUnit = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1;
    const isFlag = (v: unknown) => v === 0 || v === 1;

    for (const entry of evening.log.entries) {
      const [tag, t, seat, ...rest] = entry as unknown[];
      expect(isTime(t), JSON.stringify(entry)).toBe(true);
      expect(isSeat(seat), JSON.stringify(entry)).toBe(true);
      switch (tag) {
        case 'E':
          expect(rest).toHaveLength(2);
          expect(STRESS_EVENTS).toContain(rest[0]);
          expect(isUnit(rest[1])).toBe(true);
          break;
        case 'P':
          expect(rest).toHaveLength(4);
          expect(rest[0] === null || (typeof rest[0] === 'number' && rest[0] >= 0)).toBe(true);
          expect(isUnit(rest[1])).toBe(true);
          expect(isFlag(rest[2])).toBe(true);
          expect(isFlag(rest[3])).toBe(true);
          break;
        case 'S':
          expect(rest).toHaveLength(1);
          expect(isUnit(rest[0])).toBe(true);
          break;
        case 'F':
          expect(rest).toHaveLength(0);
          break;
        default:
          throw new Error(`unknown entry ${JSON.stringify(entry)}`);
      }
    }
  });

  it('records a pressure only when it changes', () => {
    // A seat's pressure is read on every tick. Writing it every tick would make
    // an evening tens of megabytes; writing the changes is lossless, because the
    // floor only moves when its inputs do.
    const pressures = evening.log.entries.filter((e) => e[0] === 'P').length;
    expect(pressures).toBeLessThan(evening.ticks * 4 * 0.1);
    expect(JSON.stringify(evening.log).length).toBeLessThan(2_000_000);
  });

  it('remembers when somebody left the lobby', () => {
    const recorder = new StressRecorder({ tuning: DEFAULT_TUNING });
    const match = new Match({ roomCode: 'LEAVE', hostPlayerId: 'a', clock: new ManualClock(), telemetry: recorder });
    match.join('a', 'a');
    match.join('b', 'b');
    match.leave('b');
    expect(recorder.log.entries.some((e) => e[0] === 'F' && e[2] === 1)).toBe(true);
  });
});

describe('playing it back', () => {
  it('lands on exactly what the players felt', () => {
    const result = replayStress(evening.log);
    expect(result.samples.length).toBeGreaterThan(100);
    for (const sample of result.samples) {
      expect(sample.replayed).toBeCloseTo(sample.recorded, 9);
    }
  });

  it('survives being written to disk', () => {
    // Recordings go through JSON, which has no Infinity — a stack before any
    // blinds exist is stored as null and has to come back as "comfortable".
    const roundTripped = JSON.parse(JSON.stringify(evening.log)) as StressLog;
    const a = replayStress(evening.log).samples.map((s) => s.replayed);
    const b = replayStress(roundTripped).samples.map((s) => s.replayed);
    expect(b).toEqual(a);
  });

  it('gives a different evening under a different tuning', () => {
    const base = summariseStress(replayStress(evening.log));
    const lingering = summariseStress(replayStress(evening.log, { halfLifeMs: DEFAULT_TUNING.halfLifeMs * 3 }));
    const fearless = summariseStress(
      replayStress(evening.log, { weights: { ...DEFAULT_TUNING.weights, SHOVED: { spike: 0, relief: 1 } } }),
    );

    expect(lingering.stress.mean).toBeGreaterThan(base.stress.mean);
    expect(fearless.events.SHOVED.count).toBe(base.events.SHOVED.count);
    expect(fearless.events.SHOVED.worth).toBe(0);
    // And the replay under someone else's numbers no longer matches the room.
    expect(lingering.fidelity).toBeGreaterThan(0.01);
  });

  it('leaves the recorded tuning alone when given part of one', () => {
    const result = replayStress(evening.log, { floorWeight: 0.2 });
    expect(result.tuning.floorWeight).toBe(0.2);
    expect(result.tuning.halfLifeMs).toBe(DEFAULT_TUNING.halfLifeMs);
    expect(result.tuning.weights.SHOVED).toEqual(DEFAULT_TUNING.weights.SHOVED);
  });
});

describe('reading it', () => {
  it('summarises an evening in the terms a tuning decision is made in', () => {
    const summary = summariseStress(replayStress(evening.log));
    expect(summary.minutes).toBeGreaterThan(1);
    expect(summary.arc).toHaveLength(4);
    expect(summary.share.calm + summary.share.pinned).toBeLessThanOrEqual(1);
    expect(summary.events.DEALT_IN.count).toBeGreaterThan(0);
    expect(summary.fidelity).toBeLessThan(1e-9);

    const text = formatSummary(summary);
    expect(text).toContain('stress, median');
    expect(text).toContain('last quarter');
  });

  it('says out loud which events never happened', () => {
    // The reason this instrument exists. A weight for an event nothing raises
    // is a tuning knob connected to nothing, and no assertion about the
    // arithmetic will ever notice.
    const summary = summariseStress(replayStress(evening.log));
    for (const event of summary.neverFired) expect(summary.events[event].count).toBe(0);
    for (const event of STRESS_EVENTS.filter((e) => !summary.neverFired.includes(e))) {
      expect(summary.events[event].count).toBeGreaterThan(0);
    }
  });
});
