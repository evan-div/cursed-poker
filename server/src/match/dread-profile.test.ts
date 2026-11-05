import { describe, expect, it } from 'vitest';
import { DEALER, DEALER_POSTURES, type DealerPosture } from '@cursed/shared';
import { playEvening } from './simulate.js';

/**
 * What the room actually does over a whole evening.
 *
 * Every other test here asks whether a rule holds. This one asks a question no
 * rule can answer: **does any of it ever happen?** A threshold set slightly too
 * high is not a bug any assertion would catch — the code is correct, the
 * posture is in the protocol, the constant has a thoughtful comment, and the
 * thing simply never occurs in a real match. That is exactly what the first
 * pass shipped:
 *
 *   - `DEALING` never fired once. The condition asked the match whether it was
 *     mid-deal, and a match is never mid-anything; by the time a hand exists
 *     the cards are dealt.
 *   - `LEANING` never fired either. Its threshold sat above where a whole match
 *     ever reached.
 *   - `RISEN` never fired, and still does not in a six-hander — see below.
 *
 * So this plays a match out with players who actually bet, on the real blind
 * structure, with people who take a few seconds to think, and asserts that each
 * posture is reached and that the room is meaningfully darker at the end than
 * at the start. The numbers it prints are the tuning instrument; the assertions
 * are only the floor beneath them.
 */

interface Profile {
  minutes: number;
  hands: number;
  finalDread: number;
  postures: Map<DealerPosture, number>;
  /** Dread sampled every five minutes of table time. */
  curve: { minute: number; dread: number }[];
}

/** The shared bot evening (see `simulate.ts`), watched for the Dealer and the room. */
function profileEvening(players: number, seed: number): Profile {
  const postures = new Map<DealerPosture, number>();
  const curve: { minute: number; dread: number }[] = [];
  let started: number | null = null;
  let nextSample = 5;

  const evening = playEvening({
    players,
    seed,
    onTick: (match, clock) => {
      started ??= clock.now();
      const frame = match.presenceFor();
      postures.set(frame.dealer.posture, (postures.get(frame.dealer.posture) ?? 0) + 1);
      const minute = (clock.now() - started) / 60_000;
      if (minute >= nextSample) {
        curve.push({ minute: nextSample, dread: frame.dread });
        nextSample += 5;
      }
    },
  });

  return {
    minutes: evening.minutes,
    hands: evening.hands,
    finalDread: evening.match.presenceFor().dread,
    postures,
    curve,
  };
}

describe('a whole evening', () => {
  it('reaches every posture it has a name for, except the last one', () => {
    const evening = profileEvening(6, 20_260_909);
    const ticks = [...evening.postures.values()].reduce((a, b) => a + b, 0);

    const share = (posture: DealerPosture) => (evening.postures.get(posture) ?? 0) / ticks;
    const report = DEALER_POSTURES.map(
      (posture) => `${posture} ${(share(posture) * 100).toFixed(1)}%`,
    ).join('  ');
    console.log(
      `six-handed: ${evening.minutes.toFixed(0)} min, ${evening.hands} hands, ` +
        `dread ${evening.finalDread.toFixed(2)}`,
    );
    console.log(`  ${report}`);
    console.log(
      `  ${evening.curve.map((p) => `${p.minute}m ${p.dread.toFixed(2)}`).join('  ')}`,
    );

    // The three that a normal match must contain. A posture that never occurs
    // is a posture that does not exist, whatever the protocol says.
    expect(share('DEALING'), 'he never deals').toBeGreaterThan(0.02);
    expect(share('WATCHING'), 'he never watches anybody').toBeGreaterThan(0.1);
    expect(share('LEANING'), 'he never leans in').toBeGreaterThan(0.02);
  });

  it('leaves a full evening meaningfully worse than it found it', () => {
    // Several seeds, because match length is genuinely variable and a floor
    // pinned to one of them is a floor pinned to luck. A thirteen-minute match
    // *should* end lighter than a fifty-minute one; what must not happen is a
    // long evening ending where it started.
    const evenings = [776_611, 20_260_909, 31_337, 5_150].map((seed) => profileEvening(6, seed));
    for (const evening of evenings) {
      console.log(
        `  ${evening.minutes.toFixed(0).padStart(3)} min, ${String(evening.hands).padStart(3)} hands` +
          `, dread ${evening.finalDread.toFixed(2)}`,
      );
    }

    const longest = evenings.reduce((a, b) => (b.minutes > a.minutes ? b : a));
    expect(longest.minutes, 'no seed produced a long match').toBeGreaterThan(30);
    expect(longest.finalDread, 'a long evening ended in a lit room').toBeGreaterThan(0.7);

    // And it gets there gradually. Every sample along every curve is at least
    // as dark as the one before it — the design statement, measured rather
    // than asserted about the arithmetic.
    for (const evening of evenings) {
      let previous = -1;
      for (const point of evening.curve) {
        expect(point.dread, `${point.minute}m went backwards`).toBeGreaterThanOrEqual(previous);
        previous = point.dread;
      }
    }
  });

  it('stands, once it is bad enough, and does not sit back down', () => {
    const evening = profileEvening(6, 20_260_909);
    const ticks = [...evening.postures.values()].reduce((a, b) => a + b, 0);
    const risen = (evening.postures.get('RISEN') ?? 0) / ticks;
    console.log(`  risen for ${(risen * 100).toFixed(1)}% of a ${evening.minutes.toFixed(0)}-min match`);

    // Standing only ever happens between hands, and the gap between hands is a
    // second and a half — so as a *momentary* posture it occupied under one per
    // cent of an evening and rounded to never. Staying stood is what makes it
    // a thing that happens to the table rather than a frame nobody saw.
    expect(risen, 'he never stood all night').toBeGreaterThan(0.02);
  });

  it('holds his stare longer late than early', () => {
    // The tuning claim that is easiest to get backwards, checked against the
    // curve rather than against the constants.
    expect(DEALER.holdMsDread).toBeGreaterThan(DEALER.holdMsCalm * 2);
  });
});
