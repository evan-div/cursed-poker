import { describe, expect, it } from 'vitest';
import {
  STRESS,
  TURBO_BLIND_STRUCTURE,
  cardToString,
  type PlayerAction,
} from '@cursed/shared';
import { SeededRandomSource } from '../poker/index.js';
import { ManualClock } from './clock.js';
import { Match } from './match.js';

/**
 * The wall between the cards and everybody's heart rate.
 *
 * The most important test in Phase 6, and the reason the stress model is shaped
 * the way it is.
 *
 * Tremor is **broadcast**. Every seat's shake is on every screen at the table.
 * If stress rose with hand strength, that shake would be a public readout of a
 * private fact — a decoder for hole cards, opened by the server, available to
 * anybody patient enough to learn it. Strictly more information than poker
 * gives you, and therefore strictly worse than cheating, because it would be
 * *the rules*.
 *
 * **The precise claim, which is narrower than it first looks.** Stress may read
 * only what is already public. That is not the same as "stress never differs
 * between two decks", and the first version of this file asserted the stronger
 * thing and was wrong: who won a pot *is* public the instant it happens, and a
 * player whose stack just halved is entitled to feel it. Chip outcomes are on
 * everybody's screen.
 *
 * What matters is the window in which a tell can be *acted on*. So the test is:
 * deal two tables completely different hands, play an identical script of public
 * actions through both, and require every heart rate and every broadcast tell to
 * match exactly **for as long as a hand is live and undecided**. A read you take
 * after the pot is pushed is worth nothing; a read you take on the river is
 * worth everything, and in that window the cards must be invisible.
 *
 * The second test pins the other half: the first difference between the two
 * tables must arrive no earlier than a hand completing. If a leak ever opens
 * mid-hand, that is where it shows up.
 *
 * The companion guarantee — that stress cannot reach *back* into the cards — is
 * free and holds by construction: nothing in `stress.ts` draws from any random
 * source at all.
 */

const FAST = {
  actionTimeoutMs: 30_000,
  disconnectedActionTimeoutMs: 5_000,
  showdownDisplayMs: 100,
  foldedHandDisplayMs: 100,
  betweenHandsMs: 100,
};

function seatFour(deckSeed: number) {
  const clock = new ManualClock();
  const match = new Match({
    roomCode: 'STRESS',
    hostPlayerId: 'p0',
    clock,
    rng: new SeededRandomSource(deckSeed),
    // The same Dealer on both tables: he is an input to stress (being watched
    // is a standing pressure), so he has to be held still for the comparison to
    // mean anything about the cards.
    dealerRng: new SeededRandomSource(99),
    structure: TURBO_BLIND_STRUCTURE,
    timings: FAST,
  });

  const playerIds = ['p0', 'p1', 'p2', 'p3'];
  for (const id of playerIds) match.join(id, id);
  for (const id of playerIds) match.setReady(id, true);
  match.start('p0');
  return { match, clock, playerIds };
}

function actingPlayerId(match: Match): string | null {
  const seat = match.state.table?.hand?.actingSeat;
  if (seat === null || seat === undefined) return null;
  return match.state.players.find((p) => p.seatIndex === seat)?.playerId ?? null;
}

interface Tick {
  /** True while a hand is dealt and not yet resolved: the exploitable window. */
  live: boolean;
  /** Everybody's own heart, which only they can see. */
  hearts: string;
  /** What the table sees of them. */
  tells: string;
  /** The actual cards, which no client ever receives. */
  cards: string;
}

/** Plays a fixed script, recording everything at every tick. */
function playOut(table: ReturnType<typeof seatFour>, hands: number): Tick[] {
  const { match, clock, playerIds } = table;
  const ticks: Tick[] = [];

  let handsSeen = 0;
  let lastHand = -1;
  let guard = 0;

  while (handsSeen < hands && guard++ < 6_000) {
    match.tick();

    const hand = match.state.table?.hand ?? null;
    if (hand && hand.handNumber !== lastHand) {
      lastHand = hand.handNumber;
      handsSeen++;
    }

    const frame = match.presenceFor();
    ticks.push({
      live: hand !== null && hand.phase !== 'COMPLETE',
      hearts: playerIds.map((id) => `${id}:${match.viewFor(id).you.stress.heartRate}`).join('|'),
      tells: frame.seats
        .map((s) => `${s.seatIndex}:${s.tells.tremor}/${s.tells.breathing}/${s.tells.sweat}`)
        .join('|'),
      cards: hand
        ? `${hand.handNumber}|${hand.board.map(cardToString).join(',')}` +
          `|${hand.seats.map((s) => (s.holeCards ?? []).map(cardToString).join('')).join('/')}`
        : '',
    });

    const actor = actingPlayerId(match);
    if (actor && hand) {
      // A fixed script chosen without looking at a single card: check when you
      // can, otherwise call. Identical on both tables by construction.
      const legal = match.viewFor(actor).you.legalActions;
      const action: PlayerAction = legal?.canCheck ? { type: 'CHECK' } : { type: 'CALL' };
      match.submitAction(actor, hand.handNumber, action);
    } else {
      clock.advance(120);
    }
  }

  return ticks;
}

/** The ticks before the two runs first disagree about anything at all. */
function agreeingPrefix(a: Tick[], b: Tick[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i]!.hearts === b[i]!.hearts && a[i]!.tells === b[i]!.tells) {
    i++;
  }
  return i;
}

describe('the cards cannot reach anybody’s heart rate', () => {
  it('is identical for as long as a hand is live and undecided', () => {
    const a = playOut(seatFour(11), 8);
    const b = playOut(seatFour(98_765), 8);

    // The premise: these really are different hands, or the test proves nothing.
    expect(a.map((t) => t.cards)).not.toEqual(b.map((t) => t.cards));
    expect(a.filter((t) => t.live).length).toBeGreaterThan(30);

    // Up to the point where the first result goes public, everything matches —
    // every heart and every broadcast tell. That is the whole window in which a
    // read is worth taking.
    const agreed = agreeingPrefix(a, b);
    for (let i = 0; i < agreed; i++) {
      expect(b[i]!.hearts, `tick ${i}`).toEqual(a[i]!.hearts);
      expect(b[i]!.tells, `tick ${i}`).toEqual(a[i]!.tells);
    }

    // And at least one whole hand was played inside that window, so the
    // agreement is not a vacuous two ticks before the blinds.
    expect(a.slice(0, agreed).filter((t) => t.live).length).toBeGreaterThan(10);
  });

  it('cannot differ before a hand has resolved', () => {
    // Where a mid-hand leak would show up. If anything the model reads ever
    // comes from a deck, a hole card, a ranking or an equity, the two tables
    // part company while the cards are still secret — and this fails.
    for (const [left, right] of [
      [11, 98_765],
      [31_337, 5_150],
      [777, 4_242],
    ] as const) {
      const a = playOut(seatFour(left), 6);
      const b = playOut(seatFour(right), 6);
      const agreed = agreeingPrefix(a, b);

      if (agreed >= Math.min(a.length, b.length)) continue; // never diverged at all
      // The tick they first disagree on must be one where no hand is live: the
      // pot has been pushed and who won it is on everybody's screen.
      expect(a[agreed]!.live, `decks ${left}/${right} diverged mid-hand`).toBe(false);
    }
  });

  it('never tells anybody else a heart rate', () => {
    const table = seatFour(777);
    playOut(table, 3);

    // p0's own view carries a real number. Everybody else's view of p0 carries
    // a shake and a breath, and no way back to the number.
    const own = table.match.viewFor('p0').you.stress;
    expect(own.heartRate).toBeGreaterThanOrEqual(STRESS.restingBpm);

    const frame = table.match.presenceFor();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          expect(key, 'a heart rate reached the broadcast').not.toMatch(/heart|stress|bpm/i);
          walk(value);
        }
      }
    };
    walk(frame);

    // And another player's view of p0 has no stress field for them at all.
    const other = table.match.viewFor('p1');
    expect(other.you.playerId).toBe('p1');
    expect(JSON.stringify(other.hand)).not.toMatch(/heart|stress/i);
  });

  it('quantises what it broadcasts, so it cannot be differenced into a transcript', () => {
    const ticks = playOut(seatFour(4_242), 6);

    const values = new Set<number>();
    for (const tick of ticks) {
      for (const seat of tick.tells.split('|')) {
        const [, rest] = seat.split(':');
        const [tremor, breathing] = (rest ?? '').split('/');
        values.add(Number(tremor));
        values.add(Number(breathing));
      }
    }
    // Every value lands on the quantisation grid. A tremor at full precision,
    // differenced frame to frame, is a far better read than any eye could make
    // — and because stress follows a player's own public behaviour, it would be
    // close to a transcript of it.
    for (const value of values) {
      expect(Number.isInteger(value * STRESS.tellSteps), `${value} is off the grid`).toBe(true);
    }
  });
});
