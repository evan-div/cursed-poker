import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPOSURE, type ComposureInput } from '@cursed/shared';
import { SeededRandomSource } from '../poker/index.js';
import { ManualClock } from './clock.js';
import { Match } from './match.js';
import { applyStressEvent } from './stress.js';
import type { BreathSpec } from './composure/breath.js';
import { breathChallenge, type ComposureChallenge } from './composure/index.js';

/**
 * Composure inside a match.
 *
 * Three promises. A challenge and its result are told to one player and
 * nobody else — not even by a view arriving at a telling moment. A result
 * changes what the table is shown and never what its owner feels. And a new
 * minigame is a new module: the last block plugs in a kind this codebase has
 * never seen and runs it through a whole match, and then checks the stress
 * model cannot even name it.
 */

function table(kinds?: readonly ComposureChallenge[]) {
  const clock = new ManualClock();
  const match = new Match({
    roomCode: 'CALM',
    hostPlayerId: 'p0',
    clock,
    rng: new SeededRandomSource(4),
    dealerRng: new SeededRandomSource(5),
    composureRng: new SeededRandomSource(6),
    ...(kinds ? { composureKinds: kinds } : {}),
    timings: { actionTimeoutMs: 600_000 },
  });
  const ids = ['p0', 'p1', 'p2', 'p3'];
  for (const id of ids) match.join(id, id);
  for (const id of ids) match.setReady(id, true);
  match.start('p0');

  const pushes: { events: number; only?: string }[] = [];
  match.onUpdate((events, only) => pushes.push({ events: events.length, ...(only ? { only } : {}) }));

  const seatOf = (id: string) => match.state.players.find((p) => p.playerId === id)!.seatIndex;
  const frighten = (id: string) => {
    for (let i = 0; i < 4; i++) applyStressEvent(match.state.stress, seatOf(id), 'SHOVED', clock.now());
  };
  const tellsOf = (id: string) => match.presenceFor().seats.find((s) => s.seatIndex === seatOf(id))!.tells;
  const press = (id: string, input: ComposureInput, after = 0) => {
    clock.advance(after);
    const challenge = match.viewFor(id).you.composure.challenge!;
    match.composureInput(id, challenge.id, input);
  };
  /** Taps out a breath perfectly, or holds perfectly, whichever was issued. */
  const steady = (id: string) => {
    const challenge = match.viewFor(id).you.composure.challenge!;
    if (challenge.kind === 'BREATH') {
      press(id, 'DOWN', 300);
      for (const gap of (challenge.spec as BreathSpec).gapsMs) press(id, 'DOWN', gap);
    } else {
      press(id, 'DOWN', 300);
      press(id, 'UP', challenge.spec.holdMs as number);
    }
  };
  return { match, clock, pushes, frighten, tellsOf, press, steady, seatOf };
}

describe('asking to steady yourself', () => {
  it('is only possible at a table, in a match, while you are still in it', () => {
    const clock = new ManualClock();
    const lobby = new Match({ roomCode: 'L', hostPlayerId: 'a', clock });
    lobby.join('a', 'a');
    expect(() => lobby.beginComposure('a')).toThrow(/nothing to steady/);
    expect(() => lobby.beginComposure('nobody')).toThrow(/not in this match/);
  });

  it('tells you, and only you, and does not wake anybody else', () => {
    const t = table();
    t.pushes.length = 0;
    t.match.beginComposure('p1');

    // One private push to p1. Nobody else's screen so much as refreshed.
    expect(t.pushes).toEqual([{ events: 0, only: 'p1' }]);
    const mine = t.match.viewFor('p1').you.composure.challenge;
    expect(mine).not.toBeNull();
    for (const other of ['p0', 'p2', 'p3']) {
      const view = t.match.viewFor(other);
      expect(view.you.composure.challenge).toBeNull();
      expect(JSON.stringify(view)).not.toContain(`"${mine!.id}"`);
    }
    expect(JSON.stringify(t.match.presenceFor())).not.toMatch(/composure|challenge/i);
  });

  it('will not stack challenges, and makes you wait after one', () => {
    const t = table();
    t.match.beginComposure('p1');
    expect(() => t.match.beginComposure('p1')).toThrow(/already/);
    t.steady('p1');
    expect(() => t.match.beginComposure('p1')).toThrow(/Not yet/);
    t.clock.advance(COMPOSURE.cooldownMs);
    expect(() => t.match.beginComposure('p1')).not.toThrow();
  });
});

describe('what it does', () => {
  it('quiets your tells and leaves your heart exactly where it was', () => {
    const composed = table();
    const control = table();
    for (const t of [composed, control]) t.frighten('p2');

    composed.match.beginComposure('p2');
    composed.steady('p2');
    // Bring the control table to the same moment.
    control.clock.advance(composed.clock.now() - control.clock.now());

    const view = composed.match.viewFor('p2').you.composure;
    expect(view.result?.outcome).toBe('STEADIED');

    // The table sees somebody calmer...
    const shown = composed.tellsOf('p2');
    const actual = control.tellsOf('p2');
    expect(shown.tremor + shown.breathing).toBeLessThan(actual.tremor + actual.breathing);

    // ...and they are exactly as frightened as the player who did nothing.
    expect(composed.match.selfFor('p2').stress).toEqual(control.match.selfFor('p2').stress);
    expect(composed.match.viewFor('p2').you.stress).toEqual(control.match.viewFor('p2').you.stress);
  });

  it('makes a fumbled attempt look worse than none', () => {
    const fumbled = table();
    const control = table();
    for (const t of [fumbled, control]) t.frighten('p3');

    fumbled.match.beginComposure('p3');
    const expires = fumbled.match.viewFor('p3').you.composure.challenge!.expiresAt;
    fumbled.pushes.length = 0;
    fumbled.clock.advance(expires - fumbled.clock.now());
    fumbled.match.tick();
    control.clock.advance(fumbled.clock.now() - control.clock.now());
    control.match.tick();

    expect(fumbled.match.viewFor('p3').you.composure.result?.outcome).toBe('SHAKEN');
    // Told privately when it lapsed, as when it was issued.
    expect(fumbled.pushes).toEqual([{ events: 0, only: 'p3' }]);

    const shown = fumbled.tellsOf('p3');
    const actual = control.tellsOf('p3');
    expect(shown.tremor + shown.breathing).toBeGreaterThan(actual.tremor + actual.breathing);
    expect(fumbled.match.selfFor('p3').stress).toEqual(control.match.selfFor('p3').stress);
  });

  it('cannot be claimed: inputs for somebody else, or no challenge, do nothing', () => {
    const t = table();
    t.match.beginComposure('p1');
    const id = t.match.viewFor('p1').you.composure.challenge!.id;
    // p2 tries to finish p1's challenge for them, and to finish one of its own.
    for (let i = 0; i < 10; i++) {
      t.clock.advance(1_000);
      t.match.composureInput('p2', id, 'DOWN');
    }
    expect(t.match.viewFor('p1').you.composure.challenge?.id).toBe(id);
    expect(t.match.viewFor('p2').you.composure).toEqual({ challenge: null, result: null, readyAt: 0 });
  });

  it('is refused to a player the Dealer has taken', () => {
    const t = table();
    t.match.beginComposure('p1');
    const seat = t.seatOf('p1');
    expect(t.match.state.composure.seats.some((s) => s.seatIndex === seat)).toBe(true);
    t.match.state.players.find((p) => p.playerId === 'p1')!.eliminatedAt = 1;
    expect(() => t.match.beginComposure('p1')).toThrow();
  });
});

describe('a minigame nobody has written yet', () => {
  /**
   * Knock three times. As unlike the shipped two as it can be: no rhythm, no
   * duration, just a count — and defined here, in a test, so that nothing in
   * the codebase can have been written knowing about it.
   */
  const knock: ComposureChallenge<{ [key: string]: number; knocks: number }> = {
    kind: 'KNOCK',
    issue: (rng) => ({ spec: { knocks: 3 + rng.nextInt(2) }, durationMs: 8_000 }),
    judge: (spec, inputs, final) => {
      const count = inputs.filter((i) => i.input === 'DOWN').length;
      if (count < spec.knocks) return final ? count / spec.knocks : null;
      return 1;
    },
  };

  it('runs through a match with nothing else changed', () => {
    const t = table([knock]);
    t.frighten('p0');
    const before = t.tellsOf('p0');

    t.match.beginComposure('p0');
    const challenge = t.match.viewFor('p0').you.composure.challenge!;
    expect(challenge.kind).toBe('KNOCK');
    for (let i = 0; i < (challenge.spec.knocks as number); i++) t.press('p0', 'DOWN', 100);

    expect(t.match.viewFor('p0').you.composure.result?.outcome).toBe('STEADIED');
    const after = t.tellsOf('p0');
    expect(after.tremor + after.breathing).toBeLessThan(before.tremor + before.breathing);
  });

  it('cannot reach the stress model, and the stress model cannot reach it', () => {
    // The swap is only real if the systems cannot see each other. Checked on
    // the import graph rather than by inspection, so it stays checked.
    const here = dirname(fileURLToPath(import.meta.url));
    const read = (file: string) => readFileSync(join(here, file), 'utf8');
    const imports = (source: string) => [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);

    for (const file of ['stress.ts', 'stress-telemetry.ts']) {
      expect(imports(read(file)).filter((i) => /composure/.test(i)), file).toEqual([]);
    }
    for (const file of readdirSync(join(here, 'composure')).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      expect(imports(read(join('composure', file))).filter((i) => /stress|poker\/(?!index)/.test(i)), file).toEqual([]);
    }
  });

  it('is judged by the shipped kinds the same way it is judged here', () => {
    // And the reverse: the shipped kinds are only ever reached through the
    // same interface the test kind used. Nothing special-cases them.
    const match = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'match.ts'), 'utf8');
    expect(match).not.toMatch(/breathChallenge|holdChallenge|'BREATH'|'HOLD'/);
    expect(breathChallenge.kind).toBe('BREATH');
  });
});
