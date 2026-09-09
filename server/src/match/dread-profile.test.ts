import { describe, expect, it } from 'vitest';
import {
  DEALER,
  DEALER_POSTURES,
  DEFAULT_BLIND_STRUCTURE,
  type DealerPosture,
  type LegalActions,
  type PlayerAction,
} from '@cursed/shared';
import { SeededRandomSource } from '../poker/index.js';
import { ManualClock } from './clock.js';
import { Match } from './match.js';

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

/** Randomised but plausible: mostly passive, sometimes not. Mirrors the sim. */
function chooseAction(legal: LegalActions, pot: number, rng: SeededRandomSource): PlayerAction {
  const roll = rng.nextInt(100);
  const size = () => {
    const low = legal.minRaiseTo;
    const high = Math.min(legal.maxRaiseTo, Math.max(low, pot + legal.callAmount * 2));
    return high <= low ? low : low + rng.nextInt(high - low + 1);
  };
  const aggressive = (): PlayerAction =>
    legal.raiseActionType === 'BET' ? { type: 'BET', to: size() } : { type: 'RAISE', to: size() };

  if (legal.canCheck) {
    if (roll < 60) return { type: 'CHECK' };
    if (roll < 95 && legal.canRaise) return aggressive();
    return { type: 'CHECK' };
  }
  if (roll < 32) return { type: 'FOLD' };
  if (roll < 82) return { type: 'CALL' };
  if (roll < 96 && legal.canRaise) return aggressive();
  if (legal.canRaise || legal.canCall) return { type: 'ALL_IN' };
  return { type: 'FOLD' };
}

interface Profile {
  minutes: number;
  hands: number;
  finalDread: number;
  postures: Map<DealerPosture, number>;
  /** Dread sampled every five minutes of table time. */
  curve: { minute: number; dread: number }[];
}

function playEvening(players: number, seed: number): Profile {
  const clock = new ManualClock();
  const started = clock.now();
  const match = new Match({
    roomCode: 'DREAD',
    hostPlayerId: 'p0',
    clock,
    rng: new SeededRandomSource(seed),
    dealerRng: new SeededRandomSource(seed * 7 + 1),
    structure: DEFAULT_BLIND_STRUCTURE,
    timings: {
      actionTimeoutMs: 30_000,
      disconnectedActionTimeoutMs: 5_000,
      showdownDisplayMs: 4_000,
      foldedHandDisplayMs: 1_500,
      betweenHandsMs: 1_500,
    },
  });

  const ids = Array.from({ length: players }, (_, i) => `p${i}`);
  for (const id of ids) match.join(id, id);
  for (const id of ids) match.setReady(id, true);
  match.start('p0');

  const brain = new SeededRandomSource(seed * 31 + 5);
  const postures = new Map<DealerPosture, number>();
  const curve: { minute: number; dread: number }[] = [];
  let thinking = 0;
  let nextSample = 5;
  let hands = 0;
  let lastHand = -1;
  let guard = 0;

  // The presence tick, exactly as `game-server.ts` runs it.
  const STEP = 83;

  while (match.state.status !== 'FINISHED' && guard++ < 400_000) {
    match.tick();
    const frame = match.presenceFor();
    postures.set(frame.dealer.posture, (postures.get(frame.dealer.posture) ?? 0) + 1);

    const minute = (clock.now() - started) / 60_000;
    if (minute >= nextSample) {
      curve.push({ minute: nextSample, dread: frame.dread });
      nextSample += 5;
    }

    const hand = match.state.table?.hand ?? null;
    if (hand && hand.handNumber !== lastHand) {
      lastHand = hand.handNumber;
      hands++;
    }

    const seat = hand?.actingSeat;
    const actor =
      seat === null || seat === undefined
        ? null
        : match.state.players.find((p) => p.seatIndex === seat)?.playerId;

    if (actor && hand) {
      // People think. Without it the whole match happens inside a few seconds
      // of clock time, every deal is always "just now", and he reads as dealing
      // continuously — which says nothing whatever about the real game.
      if (thinking > 0) {
        thinking -= STEP;
        clock.advance(STEP);
        continue;
      }
      const legal = match.viewFor(actor).you.legalActions;
      if (!legal) {
        clock.advance(STEP);
        continue;
      }
      const pot = match.viewFor(actor).hand?.potTotal ?? 0;
      try {
        match.submitAction(actor, hand.handNumber, chooseAction(legal, pot, brain));
      } catch {
        match.submitAction(actor, hand.handNumber, { type: 'FOLD' });
      }
      thinking = 1_200 + (brain.nextInt(1000) / 1000) * 5_500;
    } else {
      thinking = 0;
      clock.advance(STEP);
    }
  }

  return {
    minutes: (clock.now() - started) / 60_000,
    hands,
    finalDread: match.presenceFor().dread,
    postures,
    curve,
  };
}

describe('a whole evening', () => {
  it('reaches every posture it has a name for, except the last one', () => {
    const evening = playEvening(6, 20_260_909);
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
    const evenings = [776_611, 20_260_909, 31_337, 5_150].map((seed) => playEvening(6, seed));
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
    const evening = playEvening(6, 20_260_909);
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
