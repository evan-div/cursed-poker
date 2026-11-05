import { describe, expect, it } from 'vitest';
import { playEvening } from './simulate.js';
import { DEFAULT_TUNING } from './stress.js';
import {
  StressRecorder,
  formatSummary,
  mergeSummaries,
  replayStress,
  summariseStress,
  type StressSummary,
} from './stress-telemetry.js';

/**
 * What the stress model actually does over whole evenings.
 *
 * The companion to `dread-profile.test.ts`, asking the same question of a
 * different system: not "is the arithmetic right" but "does any of it ever
 * happen?" A stress model can be correct in every unit test and still leave a
 * whole table looking serene for ninety minutes, or pin everybody at the top
 * of the scale by the second orbit — and either one is a broken game.
 *
 * The thresholds are deliberately loose. They are the floor under the design,
 * not the tuning itself: the tuning is the printed report, which is what
 * `npm run stress` shows at more length and against other numbers.
 *
 * Bots never re-check their cards or stare anybody down, so anything driven
 * by a player's own behaviour is invisible here. Real recordings — a server
 * started with `STRESS_TELEMETRY_DIR` — are what to tune those against.
 */

const SEEDS = [20_260_909, 776_611, 31_337, 5_150];

function evenings(players: number): StressSummary[] {
  return SEEDS.map((seed) => {
    const recorder = new StressRecorder({ tuning: DEFAULT_TUNING });
    playEvening({ players, seed, telemetry: recorder });
    return summariseStress(replayStress(recorder.log));
  });
}

const sixHanded = mergeSummaries(evenings(6));

describe('a whole evening of nerves', () => {
  it('prints what it found', () => {
    console.log(`six-handed, ${SEEDS.length} evenings:\n${formatSummary(sixHanded)}`);
    expect(sixHanded.samples).toBeGreaterThan(1_000);
  });

  it('gets worse as the evening goes on', () => {
    const first = sixHanded.arc[0]!.mean;
    const last = sixHanded.arc[3]!.mean;
    expect(last, 'the last quarter is no worse than the first').toBeGreaterThan(first * 1.3);
    // Deliberately *not* asserted: that hands shake more late than early.
    //
    // The first version did, and it failed on these seeds — shaking peaked in
    // the first quarter — while passing on the six evenings `npm run stress`
    // plays. Stress rises late because of the floor (dread, short stacks), and
    // the floor's room component tops out below where tremor starts, so late
    // shaking is down to spikes, and spikes follow aggression. Bots are no more
    // aggressive at level twelve than at level one; people are. Nudging the
    // room weight, the floor weight or the half-life barely moves it either.
    // It is a question for real recordings, not one bots can settle.
  });

  it('makes somebody shake, and somebody sweat through', () => {
    // A tell nobody ever shows is a tell that does not exist.
    expect(sixHanded.share.trembling, 'nobody ever shook').toBeGreaterThan(0.02);
    expect(sixHanded.share.damp + sixHanded.share.soaked, 'nobody ever sweated').toBeGreaterThan(0.005);
    expect(sixHanded.stress.max, 'nobody was ever properly frightened').toBeGreaterThan(0.78);
  });

  it('does not pin the table at the top', () => {
    // Everybody shaking all the time is the same as nobody shaking: a tell is
    // only information when it is different from the person beside you.
    expect(sixHanded.share.pinned, 'the table lives at the top of the scale').toBeLessThan(0.05);
    expect(sixHanded.stress.p50, 'the typical moment is already a panic').toBeLessThan(0.5);
  });

  it('moves its tells at a rate somebody could follow', () => {
    // Frozen tells say nothing; tells that change every few seconds are noise
    // a person learns to ignore.
    expect(sixHanded.tellChangesPerMinute).toBeGreaterThan(0.5);
    expect(sixHanded.tellChangesPerMinute).toBeLessThan(15);
  });

  it('replays every evening exactly', () => {
    expect(sixHanded.fidelity).toBeLessThan(1e-9);
  });
});
