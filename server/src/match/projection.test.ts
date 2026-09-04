import { describe, expect, it } from 'vitest';
import { TURBO_BLIND_STRUCTURE, type Card, type ClientView, type PlayerAction } from '@cursed/shared';
import { SeededRandomSource, legalActions } from '../poker/index.js';
import { ManualClock } from './clock.js';
import { Match } from './match.js';

/**
 * Hidden-information tests.
 *
 * These are the most important tests in the project. Everything else protects
 * fairness; these protect the thing fairness is *for* — that a player's cards
 * are their own. They run over live fuzzed matches and check every viewer's
 * view at every decision point, structurally rather than by string matching.
 */

// Arrays of numbers that legitimately appear in a view, classified. Anything
// else fails the audit below, so a newly added card field cannot slip through
// unclassified.
const CARD_FIELDS = new Set(['board', 'holeCards', 'revealedCards', 'bestFive']);
const SEAT_INDEX_FIELDS = new Set(['contenders', 'eligibleSeats']);
const FORBIDDEN_KEYS = new Set(['deck', 'burned', 'cards']);

interface FoundArray {
  path: string;
  key: string;
  values: number[];
}

function auditView(view: ClientView): FoundArray[] {
  const found: FoundArray[] = [];

  const walk = (node: unknown, path: string, key: string): void => {
    if (Array.isArray(node)) {
      if (node.length > 0 && node.every((v) => typeof v === 'number')) {
        found.push({ path, key, values: node as number[] });
        return;
      }
      node.forEach((child, i) => walk(child, `${path}[${i}]`, key));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [childKey, value] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.has(childKey)) {
          throw new Error(`View exposes forbidden key "${childKey}" at ${path}`);
        }
        walk(value, `${path}.${childKey}`, childKey);
      }
    }
  };

  walk(view, '$', '$');
  return found;
}

/** Every card this viewer is legitimately entitled to see, right now. */
function permittedCards(match: Match, playerId: string): Set<Card> {
  const allowed = new Set<Card>();
  const hand = match.state.table?.hand;

  for (const card of hand?.board ?? []) allowed.add(card);

  const seat = match.state.players.find((p) => p.playerId === playerId)?.seatIndex;
  const own = hand?.seats.find((s) => s.seatIndex === seat)?.holeCards;
  for (const card of own ?? []) allowed.add(card);

  // Showdown reveals are public by the rules of poker.
  for (const reveal of hand?.result?.showdown ?? []) {
    for (const card of reveal.holeCards) allowed.add(card);
    for (const card of reveal.bestFive) allowed.add(card);
  }
  for (const reveal of match.state.lastResult?.showdown ?? []) {
    for (const card of reveal.holeCards) allowed.add(card);
    for (const card of reveal.bestFive) allowed.add(card);
  }
  return allowed;
}

function assertNoLeak(match: Match, playerId: string | null): void {
  const view = match.viewFor(playerId);
  const allowed = playerId === null ? new Set<Card>() : permittedCards(match, playerId);
  // A spectator may still see the community cards.
  for (const card of match.state.table?.hand?.board ?? []) allowed.add(card);
  if (playerId === null) {
    for (const reveal of match.state.lastResult?.showdown ?? []) {
      for (const card of reveal.holeCards) allowed.add(card);
      for (const card of reveal.bestFive) allowed.add(card);
    }
    for (const reveal of match.state.table?.hand?.result?.showdown ?? []) {
      for (const card of reveal.holeCards) allowed.add(card);
      for (const card of reveal.bestFive) allowed.add(card);
    }
  }

  for (const entry of auditView(view)) {
    if (SEAT_INDEX_FIELDS.has(entry.key)) continue;
    if (!CARD_FIELDS.has(entry.key)) {
      throw new Error(
        `Unclassified numeric array "${entry.key}" at ${entry.path}. ` +
          `Classify it as cards or seat indices before shipping.`,
      );
    }
    for (const card of entry.values) {
      if (!allowed.has(card)) {
        throw new Error(
          `Viewer ${playerId ?? '(spectator)'} was shown card ${card} at ${entry.path}, ` +
            `which they are not entitled to see`,
        );
      }
    }
  }
}

interface Harness {
  match: Match;
  clock: ManualClock;
  rng: SeededRandomSource;
  playerIds: string[];
}

function startMatch(playerCount: number, seed: number): Harness {
  const clock = new ManualClock();
  const rng = new SeededRandomSource(seed);
  const match = new Match({
    roomCode: 'TESTED',
    hostPlayerId: 'p0',
    clock,
    rng,
    structure: TURBO_BLIND_STRUCTURE,
    timings: {
      actionTimeoutMs: 30_000,
      disconnectedActionTimeoutMs: 5_000,
      showdownDisplayMs: 100,
      foldedHandDisplayMs: 100,
      betweenHandsMs: 100,
    },
  });

  const playerIds = Array.from({ length: playerCount }, (_, i) => `p${i}`);
  for (const id of playerIds) {
    match.join(id, `Player ${id}`);
    match.setReady(id, true);
  }
  match.start('p0');
  return { match, clock, rng, playerIds };
}

function randomAction(match: Match, seatIndex: number, rng: SeededRandomSource): PlayerAction {
  const legal = legalActions(match.state.table!.hand!, seatIndex);
  const roll = rng.nextInt(100);
  if (legal.canCheck) {
    if (roll < 70) return { type: 'CHECK' };
    if (roll < 90 && legal.canRaise) {
      const span = legal.maxRaiseTo - legal.minRaiseTo;
      return {
        type: legal.raiseActionType,
        to: legal.minRaiseTo + (span > 0 ? rng.nextInt(span + 1) : 0),
      } as PlayerAction;
    }
    return { type: 'CHECK' };
  }
  if (roll < 25) return { type: 'FOLD' };
  if (roll < 85) return { type: 'CALL' };
  if (legal.canRaise) {
    const span = legal.maxRaiseTo - legal.minRaiseTo;
    return {
      type: legal.raiseActionType,
      to: legal.minRaiseTo + (span > 0 ? rng.nextInt(span + 1) : 0),
    } as PlayerAction;
  }
  return { type: 'CALL' };
}

/**
 * Plays a whole match, auditing every viewer's view at every decision point.
 *
 * Some players look at their cards and some never do, so the audit covers both
 * a view that legitimately carries hole cards and one that carries none.
 */
function playAudited(h: Harness, maxSteps = 40_000): number {
  let audits = 0;
  let steps = 0;
  let peekedHand = -1;

  while (h.match.state.status === 'IN_PROGRESS' && steps++ < maxSteps) {
    const current = h.match.state.table?.hand;
    if (current && current.handNumber !== peekedHand) {
      peekedHand = current.handNumber;
      for (const player of h.match.state.players) {
        if (h.rng.nextInt(4) === 0) continue; // one in four never looks
        if (!current.seats.some((s) => s.seatIndex === player.seatIndex)) continue;
        h.match.peek(player.playerId, current.handNumber);
      }
    }

    for (const id of [...h.playerIds, null]) {
      assertNoLeak(h.match, id);
      audits++;
    }

    const hand = h.match.state.table?.hand;
    if (h.match.state.phase === 'HAND_IN_PROGRESS' && hand && hand.actingSeat !== null) {
      const seatIndex = hand.actingSeat;
      const player = h.match.state.players.find((p) => p.seatIndex === seatIndex)!;
      h.match.submitAction(player.playerId, hand.handNumber, randomAction(h.match, seatIndex, h.rng));
    } else {
      h.clock.advance(200);
    }
  }

  for (const id of [...h.playerIds, null]) assertNoLeak(h.match, id);
  return audits;
}

describe('the projection boundary', () => {
  it('never shows a player a card they are not entitled to, across whole matches', () => {
    let audits = 0;
    for (const [count, seed] of [
      [4, 11],
      [5, 23],
      [6, 37],
      [6, 41],
      [4, 53],
    ] as const) {
      const h = startMatch(count, seed);
      audits += playAudited(h);
      expect(h.match.state.status).toBe('FINISHED');
      h.match.dispose();
    }
    expect(audits).toBeGreaterThan(1_000);
  });

  it('shows a player their own hole cards and nobody else any of them', () => {
    const h = startMatch(6, 99);
    const hand = h.match.state.table!.hand!;
    for (const player of h.match.state.players) h.match.peek(player.playerId, hand.handNumber);

    for (const player of h.match.state.players) {
      const view = h.match.viewFor(player.playerId);
      const own = hand.seats.find((s) => s.seatIndex === player.seatIndex)!.holeCards!;
      expect(view.you.holeCards).toEqual([...own]);

      // Nobody else's cards are anywhere in the view.
      for (const seat of view.hand!.seats) {
        expect(seat.revealedCards).toBeNull();
      }
      for (const other of hand.seats) {
        if (other.seatIndex === player.seatIndex) continue;
        const leaked = auditView(view).some((entry) =>
          entry.values.some((v) => CARD_FIELDS.has(entry.key) && other.holeCards!.includes(v as Card)),
        );
        // The only way another player's card may appear is if it is also on the
        // board or in the viewer's own hand, which cannot happen preflop.
        expect(leaked).toBe(false);
      }
    }
    h.match.dispose();
  });

  it('reveals nothing when a hand is won without a showdown', () => {
    const h = startMatch(4, 7);
    const hand = h.match.state.table!.hand!;

    // Everyone folds to the big blind.
    let guard = 0;
    while (h.match.state.table?.hand?.actingSeat !== null && guard++ < 20) {
      const current = h.match.state.table!.hand!;
      const player = h.match.state.players.find((p) => p.seatIndex === current.actingSeat)!;
      h.match.submitAction(player.playerId, current.handNumber, { type: 'FOLD' });
    }

    const finished = h.match.state.table!.hand!;
    expect(finished.phase).toBe('COMPLETE');
    expect(finished.result!.showdown).toBeNull();

    for (const player of h.match.state.players) {
      const view = h.match.viewFor(player.playerId);
      for (const seat of view.hand!.seats) expect(seat.revealedCards).toBeNull();
      assertNoLeak(h.match, player.playerId);
    }
    expect(hand.handNumber).toBe(1);
    h.match.dispose();
  });

  it('shows every contender at a showdown to everyone, including the eliminated', () => {
    // Drive matches until one produces a showdown, then check what everyone sees.
    for (let seed = 1; seed < 40; seed++) {
      const h = startMatch(4, seed * 13);
      let guard = 0;
      while (h.match.state.status === 'IN_PROGRESS' && guard++ < 400) {
        const hand = h.match.state.table?.hand;
        if (hand?.result?.showdown && hand.result.showdown.length > 1) {
          const reveals = hand.result.showdown;
          for (const player of h.match.state.players) {
            const view = h.match.viewFor(player.playerId);
            const shown = view.hand!.seats.filter((s) => s.revealedCards !== null);
            expect(shown.map((s) => s.seatIndex).sort()).toEqual(
              reveals.map((r) => r.seatIndex).sort(),
            );
            for (const seat of shown) {
              expect(seat.handCategory).not.toBeNull();
              expect(seat.bestFive).toHaveLength(5);
            }
          }
          h.match.dispose();
          return;
        }
        if (hand && hand.actingSeat !== null) {
          const player = h.match.state.players.find((p) => p.seatIndex === hand.actingSeat)!;
          h.match.submitAction(player.playerId, hand.handNumber, randomAction(h.match, hand.actingSeat, h.rng));
        } else {
          h.clock.advance(50);
        }
      }
      h.match.dispose();
    }
    throw new Error('No showdown occurred in 40 matches — the harness is broken');
  });

  it('withholds a player\'s own cards until they look at them', () => {
    const h = startMatch(5, 4242);
    const hand = h.match.state.table!.hand!;

    // Dealt, but not looked at: the client has nothing to render and nothing
    // a modified build could render early.
    for (const player of h.match.state.players) {
      const view = h.match.viewFor(player.playerId);
      expect(view.you.holeCards).toBeNull();
      expect(view.you.hasPeeked).toBe(false);
    }

    h.match.peek('p2', hand.handNumber);
    const looked = h.match.viewFor('p2');
    expect(looked.you.hasPeeked).toBe(true);
    expect(looked.you.holeCards).toHaveLength(2);

    // Looking is private to the looker. Nobody else's view changed.
    expect(h.match.viewFor('p1').you.holeCards).toBeNull();

    // And it survives a drop: a player who has already seen their cards does
    // not have to earn them again by reconnecting.
    h.match.setConnected('p2', false);
    h.match.setConnected('p2', true);
    expect(h.match.viewFor('p2').you.holeCards).toEqual(looked.you.holeCards);

    h.match.dispose();
  });

  it('makes every player look again when the next hand is dealt', () => {
    const h = startMatch(4, 77);
    const first = h.match.state.table!.hand!.handNumber;
    for (const player of h.match.state.players) h.match.peek(player.playerId, first);
    expect(h.match.viewFor('p0').you.holeCards).toHaveLength(2);

    // Fold the hand out and let the next one be dealt.
    let guard = 0;
    while (h.match.state.status === 'IN_PROGRESS' && guard++ < 200) {
      const hand = h.match.state.table?.hand;
      if (hand && hand.handNumber !== first) break;
      if (hand && hand.actingSeat !== null) {
        const player = h.match.state.players.find((p) => p.seatIndex === hand.actingSeat)!;
        h.match.submitAction(player.playerId, hand.handNumber, { type: 'FOLD' });
      } else {
        h.clock.advance(100);
      }
    }

    expect(h.match.state.table!.hand!.handNumber).not.toBe(first);
    for (const player of h.match.state.players) {
      expect(h.match.viewFor(player.playerId).you.holeCards).toBeNull();
    }
    h.match.dispose();
  });

  it('refuses a peek at a hand that is not the one being played', () => {
    const h = startMatch(4, 5);
    const hand = h.match.state.table!.hand!;
    expect(() => h.match.peek('p0', hand.handNumber + 1)).toThrow(/ended/);
    expect(() => h.match.peek('nobody', hand.handNumber)).toThrow(/not in this match/);
    expect(h.match.viewFor('p0').you.holeCards).toBeNull();
    h.match.dispose();
  });

  it('gives an unknown viewer nothing but public state', () => {
    const h = startMatch(5, 1234);
    const view = h.match.viewFor('not-a-player');
    expect(view.you.holeCards).toBeNull();
    expect(view.you.seatIndex).toBeNull();
    expect(view.you.legalActions).toBeNull();
    expect(view.hand!.seats).toHaveLength(5);
    assertNoLeak(h.match, null);
    h.match.dispose();
  });

  it('only offers legal actions to the player actually on turn', () => {
    const h = startMatch(6, 555);
    const acting = h.match.state.table!.hand!.actingSeat;
    for (const player of h.match.state.players) {
      const view = h.match.viewFor(player.playerId);
      if (player.seatIndex === acting) {
        expect(view.you.legalActions).not.toBeNull();
        expect(view.you.legalActions!.seatIndex).toBe(player.seatIndex);
      } else {
        expect(view.you.legalActions).toBeNull();
      }
    }
    h.match.dispose();
  });
});
