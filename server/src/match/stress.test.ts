import { describe, expect, it } from 'vitest';
import { STRESS, STRESS_EVENTS, heartRateFor, tellsFor, type StressEvent } from '@cursed/shared';
import {
  applyStressEvent,
  createStress,
  floorFor,
  forgetStress,
  projectSelfStress,
  projectTells,
  settleStress,
  stressOf,
  type StandingPressure,
} from './stress.js';

/**
 * The stress model.
 *
 * `stress-boundary.test.ts` holds the rule that matters — that none of this may
 * read a card. This file is about whether the thing behaves like a body: spikes
 * when something happens, settles afterwards, and does not settle below a
 * situation that has not gone away.
 */

const T0 = 1_700_000_000_000;

function pressure(over: Partial<StandingPressure> = {}): StandingPressure {
  return { seatIndex: 0, stackBlinds: 100, dread: 0, watched: false, inHand: true, ...over };
}

describe('spikes', () => {
  it('starts at nothing and rises when something happens', () => {
    const stress = createStress();
    expect(stressOf(stress, 0, T0)).toBe(0);

    applyStressEvent(stress, 0, 'FACED_ALL_IN', T0);
    expect(stressOf(stress, 0, T0)).toBeGreaterThan(0.2);
  });

  it('fades', () => {
    const stress = createStress();
    applyStressEvent(stress, 0, 'FACED_ALL_IN', T0);
    const immediate = stressOf(stress, 0, T0);
    expect(stressOf(stress, 0, T0 + 30_000)).toBeLessThan(immediate / 2);
  });

  it('lets relief fade faster than fright', () => {
    const won = createStress();
    const lost = createStress();
    applyStressEvent(won, 0, 'WON_POT', T0);
    applyStressEvent(lost, 0, 'LOST_POT', T0);

    // Winning spikes nearly as hard as losing — a heart does not know the
    // difference in the moment — and then it goes away, which is what relief
    // actually is.
    const later = T0 + 20_000;
    expect(stressOf(won, 0, later)).toBeLessThan(stressOf(lost, 0, later) / 2);
  });

  it('scales with how big the thing was', () => {
    const small = createStress();
    const large = createStress();
    applyStressEvent(small, 0, 'FACED_BET', T0, 0.1);
    applyStressEvent(large, 0, 'FACED_BET', T0, 1);
    expect(stressOf(large, 0, T0)).toBeGreaterThan(stressOf(small, 0, T0) * 3);
  });

  it('accumulates, and never past one', () => {
    const stress = createStress();
    for (let i = 0; i < 60; i++) applyStressEvent(stress, 0, 'FACED_ALL_IN', T0 + i);
    expect(stressOf(stress, 0, T0 + 60)).toBeLessThanOrEqual(1);
    expect(stressOf(stress, 0, T0 + 60)).toBeGreaterThan(0.9);
  });

  it('decays the same however often it is read', () => {
    // Lazily decayed on read rather than ticked, so an idle table costs nothing
    // — and so a replay lands on the same numbers whatever rate it was stepped
    // at. That only works if reading does not change the answer.
    const once = createStress();
    const often = createStress();
    applyStressEvent(once, 0, 'LOST_POT', T0);
    applyStressEvent(often, 0, 'LOST_POT', T0);
    for (let i = 0; i < 500; i++) stressOf(often, 0, T0 + i * 20);

    expect(stressOf(often, 0, T0 + 10_000)).toBeCloseTo(stressOf(once, 0, T0 + 10_000), 9);
  });

  it('has a weight for every event it names', () => {
    const stress = createStress();
    for (const event of STRESS_EVENTS) {
      applyStressEvent(stress, 0, event as StressEvent, T0);
      expect(stressOf(stress, 0, T0), event).toBeGreaterThan(0);
      forgetStress(stress, 0);
    }
  });
});

describe('the floor', () => {
  it('is nothing when somebody is comfortable in a calm room', () => {
    expect(floorFor(pressure({ stackBlinds: 120 }))).toBe(0);
  });

  it('rises as a stack shrinks', () => {
    const deep = floorFor(pressure({ stackBlinds: 60 }));
    const short = floorFor(pressure({ stackBlinds: 15 }));
    const desperate = floorFor(pressure({ stackBlinds: 3 }));
    expect(short).toBeGreaterThan(deep);
    expect(desperate).toBeGreaterThan(short);
  });

  it('rises with the room, for everybody at once', () => {
    expect(floorFor(pressure({ dread: 0.9 }))).toBeGreaterThan(floorFor(pressure({ dread: 0 })));
  });

  it('rises when the thing at the head of the table is looking at you', () => {
    expect(floorFor(pressure({ watched: true }))).toBeGreaterThan(floorFor(pressure()));
  });

  it('does not decay, because the situation has not stopped', () => {
    const stress = createStress();
    settleStress(stress, [pressure({ stackBlinds: 2 })], T0);
    const now = stressOf(stress, 0, T0);

    // Ten minutes later, still down to two big blinds, still just as bad.
    settleStress(stress, [pressure({ stackBlinds: 2 })], T0 + 600_000);
    expect(stressOf(stress, 0, T0 + 600_000)).toBeCloseTo(now, 6);
    expect(now).toBeGreaterThan(0.2);
  });

  it('is a floor rather than an addition', () => {
    // A spike on top of a bad situation makes things worse, but the two do not
    // simply sum — somebody already terrified has less headroom left.
    const stress = createStress();
    settleStress(stress, [pressure({ stackBlinds: 2, dread: 0.9 })], T0);
    const standing = stressOf(stress, 0, T0);
    applyStressEvent(stress, 0, 'FACED_ALL_IN', T0);
    const spiked = stressOf(stress, 0, T0);

    expect(spiked).toBeGreaterThan(standing);
    expect(spiked).toBeLessThanOrEqual(1);
  });
});

describe('what it shows', () => {
  it('turns a heart rate into beats a person would recognise', () => {
    expect(heartRateFor(0)).toBe(STRESS.restingBpm);
    expect(heartRateFor(1)).toBe(STRESS.maxBpm);
    expect(heartRateFor(0.5)).toBeGreaterThan(STRESS.restingBpm);
  });

  it('starts breathing before it starts shaking', () => {
    // The thing that makes three tells read as a progression rather than as one
    // bar drawn three ways: breathing is already moving while somebody still
    // looks composed, and hands come later.
    const mild = tellsFor(0.25);
    expect(mild.breathing).toBeGreaterThan(0);
    expect(mild.tremor).toBe(0);

    const bad = tellsFor(0.9);
    expect(bad.tremor).toBeGreaterThan(0.5);
  });

  it('sweats last and coarsest', () => {
    expect(tellsFor(0.2).sweat).toBe('DRY');
    expect(tellsFor(0.6).sweat).toBe('DAMP');
    expect(tellsFor(0.95).sweat).toBe('SOAKED');
  });

  it('rounds everything it broadcasts onto a grid', () => {
    for (let i = 0; i <= 100; i++) {
      const tells = tellsFor(i / 100);
      expect(Number.isInteger(tells.tremor * STRESS.tellSteps)).toBe(true);
      expect(Number.isInteger(tells.breathing * STRESS.tellSteps)).toBe(true);
    }
  });

  it('shows a seat nobody has heard of as calm', () => {
    expect(projectTells(createStress(), 4, T0)).toEqual(tellsFor(0));
    expect(projectSelfStress(createStress(), null, T0).heartRate).toBe(STRESS.restingBpm);
  });

  it('gives its owner a real number and the table a rounded one', () => {
    const stress = createStress();
    applyStressEvent(stress, 2, 'SHOVED', T0);

    const own = projectSelfStress(stress, 2, T0);
    expect(own.heartRate).toBeGreaterThan(STRESS.restingBpm);

    const seen = projectTells(stress, 2, T0);
    expect(Number.isInteger(seen.breathing * STRESS.tellSteps)).toBe(true);
  });
});

describe('leaving', () => {
  it('forgets a seat that has left the lobby', () => {
    const stress = createStress();
    applyStressEvent(stress, 1, 'SHOVED', T0);
    expect(stressOf(stress, 1, T0)).toBeGreaterThan(0);

    forgetStress(stress, 1);
    expect(stressOf(stress, 1, T0)).toBe(0);
  });
});
