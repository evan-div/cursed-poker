import { describe, expect, it } from 'vitest';
import { TURBO_BLIND_STRUCTURE, cardToString, type PlayerAction } from '@cursed/shared';
import { SeededRandomSource, type RandomSource } from '../poker/index.js';
import { ManualClock } from './clock.js';
import { Match } from './match.js';

/**
 * The two walls between the Dealer and the cards.
 *
 * `dealer.test.ts` checks what he does. This checks what he *cannot* do, and it
 * does it through whole running matches rather than synthetic contexts, because
 * both guarantees are about how the pieces are wired together and a unit test
 * on either piece alone would miss a bad wire between them.
 *
 *   1. **The cards cannot reach him.** Deal two tables completely different
 *      hands, play the identical sequence of public actions, and he must do the
 *      identical thing. If anything he reads ever comes from a deck, this fails.
 *
 *   2. **He cannot reach the cards.** Give two tables the same deck and let him
 *      fidget differently on each. Every card dealt must be identical. If his
 *      chance and the shuffle's chance are ever the same object, this fails.
 *
 * The second is the one the whole project rests on: poker is sacred, and the
 * supernatural layer does not get a side door into it.
 */

const FAST = {
  actionTimeoutMs: 30_000,
  disconnectedActionTimeoutMs: 5_000,
  showdownDisplayMs: 100,
  foldedHandDisplayMs: 100,
  betweenHandsMs: 100,
};

interface TableOptions {
  /** Seeds the shuffle. Different seeds deal different cards. */
  deckSeed: number;
  /** Seeds the Dealer. Different seeds make him behave differently. */
  dealerSeed: number;
  /** Wraps the shuffle's source, so a test can watch it being used. */
  watchDeck?: (source: RandomSource) => RandomSource;
}

function seatFour({ deckSeed, dealerSeed, watchDeck }: TableOptions) {
  const clock = new ManualClock();
  const deck: RandomSource = new SeededRandomSource(deckSeed);
  const match = new Match({
    roomCode: 'DEALER',
    hostPlayerId: 'p0',
    clock,
    rng: watchDeck ? watchDeck(deck) : deck,
    dealerRng: new SeededRandomSource(dealerSeed),
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

/**
 * Plays a fixed script of public actions, ticking the Dealer as the real
 * presence loop does, and records everything each side produced.
 */
function playOut(table: ReturnType<typeof seatFour>, hands: number) {
  const { match, clock } = table;
  const dealerLog: string[] = [];
  const cardLog: string[] = [];

  const observe = () => {
    match.tick();
    const shown = match.presenceFor().dealer;
    const gaze = shown.gaze.kind === 'SEAT' ? `SEAT${shown.gaze.seatIndex}` : shown.gaze.kind;
    dealerLog.push(`${shown.posture}:${gaze}:${shown.twitchAt ?? '-'}`);

    const hand = match.state.table?.hand;
    if (hand) {
      // Straight from the authoritative table: the actual dealt cards, which no
      // client ever sees and which must not depend on him in any way.
      cardLog.push(
        `${hand.handNumber}|${hand.board.map(cardToString).join(',')}` +
          `|${hand.seats.map((s) => (s.holeCards ?? []).map(cardToString).join('')).join('/')}`,
      );
    }
  };

  let handsSeen = 0;
  let lastHand = -1;
  let guard = 0;
  while (handsSeen < hands && guard++ < 4_000) {
    observe();

    const hand = match.state.table?.hand;
    if (hand && hand.handNumber !== lastHand) {
      lastHand = hand.handNumber;
      handsSeen++;
    }

    const actor = actingPlayerId(match);
    if (actor && hand) {
      // A fixed script, identical on both tables and chosen without looking at
      // a single card: check when you can, otherwise call.
      const legal = match.viewFor(actor).you.legalActions;
      const action: PlayerAction = legal?.canCheck ? { type: 'CHECK' } : { type: 'CALL' };
      match.submitAction(actor, hand.handNumber, action);
    } else {
      clock.advance(120);
    }
  }

  return { dealerLog, cardLog };
}

describe('the cards cannot reach the Dealer', () => {
  it('behaves identically at two tables holding completely different hands', () => {
    // Different decks, same Dealer seed, same script of public actions.
    const a = playOut(seatFour({ deckSeed: 11, dealerSeed: 4242 }), 6);
    const b = playOut(seatFour({ deckSeed: 98_765, dealerSeed: 4242 }), 6);

    // The premise: these really are different hands, or the test proves nothing.
    expect(a.cardLog).not.toEqual(b.cardLog);
    expect(a.cardLog.length).toBeGreaterThan(20);

    expect(b.dealerLog).toEqual(a.dealerLog);
  });
});

describe('the Dealer cannot reach the cards', () => {
  it('deals the same cards however differently he behaves', () => {
    // Same deck, different Dealer. If he drew from the shuffle's source, the
    // deck would shift the first time he twitched at a different moment.
    const a = playOut(seatFour({ deckSeed: 31_337, dealerSeed: 1 }), 6);
    const b = playOut(seatFour({ deckSeed: 31_337, dealerSeed: 999_983 }), 6);

    // The premise, again: he really did behave differently.
    expect(b.dealerLog).not.toEqual(a.dealerLog);

    expect(b.cardLog).toEqual(a.cardLog);
    expect(a.cardLog.length).toBeGreaterThan(20);
  });

  it('never once draws from the shuffle, however hard he is thinking', () => {
    // The sharpest form of the guarantee, and the only one that does not depend
    // on luck: count every draw the deck's source is asked for. Two tables with
    // the same deck and wildly different Dealers must consume it identically —
    // not just deal the same cards, but reach for chance the same number of
    // times. A shared source shows up here immediately, even in the case where
    // the extra draws happened to land on the same cards anyway.
    const draws = (dealerSeed: number) => {
      let taken = 0;
      const table = seatFour({
        deckSeed: 31_337,
        dealerSeed,
        watchDeck: (source) => ({
          nextInt: (maxExclusive: number) => {
            taken++;
            return source.nextInt(maxExclusive);
          },
        }),
      });
      const played = playOut(table, 6);
      return { taken, ...played };
    };

    const calm = draws(1);
    const busy = draws(999_983);

    // The premise: he really did behave differently at the two tables.
    expect(busy.dealerLog).not.toEqual(calm.dealerLog);
    expect(calm.taken).toBeGreaterThan(100);
    expect(busy.taken).toBe(calm.taken);
  });
});
