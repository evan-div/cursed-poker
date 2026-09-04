import { describe, expect, it } from 'vitest';
import {
  TURBO_BLIND_STRUCTURE,
  type BlindStructure,
  type MatchEvent,
  type PlayerAction,
} from '@cursed/shared';
import { SeededRandomSource } from '../poker/index.js';
import { ManualClock } from './clock.js';
import { Match, MatchError } from './match.js';

const FAST = {
  actionTimeoutMs: 30_000,
  disconnectedActionTimeoutMs: 5_000,
  showdownDisplayMs: 100,
  foldedHandDisplayMs: 100,
  betweenHandsMs: 100,
};

/** Two big blinds each, so players bust within a few hands. */
const SHORT_STACKS: BlindStructure = {
  id: 'test-short',
  label: 'Test (short stacks)',
  startingStackBigBlinds: 2,
  levels: [{ level: 1, smallBlind: 50, bigBlind: 100, ante: 0, durationSeconds: 36_000 }],
};

function makeMatch(options: { players?: number; structure?: BlindStructure; seed?: number } = {}) {
  const clock = new ManualClock();
  const rng = new SeededRandomSource(options.seed ?? 1);
  const events: MatchEvent[] = [];
  const match = new Match({
    roomCode: 'TESTED',
    hostPlayerId: 'p0',
    clock,
    rng,
    structure: options.structure ?? TURBO_BLIND_STRUCTURE,
    timings: FAST,
  });
  match.onUpdate((batch) => events.push(...batch));

  const count = options.players ?? 4;
  const playerIds = Array.from({ length: count }, (_, i) => `p${i}`);
  for (const id of playerIds) match.join(id, `Player ${id}`);
  return { match, clock, rng, events, playerIds };
}

function readyAndStart(h: ReturnType<typeof makeMatch>) {
  for (const id of h.playerIds) h.match.setReady(id, true);
  h.match.start('p0');
  return h;
}

function actingPlayerId(match: Match): string | null {
  const seat = match.state.table?.hand?.actingSeat;
  if (seat === null || seat === undefined) return null;
  return match.state.players.find((p) => p.seatIndex === seat)?.playerId ?? null;
}

function actNow(match: Match, action: PlayerAction): void {
  const hand = match.state.table!.hand!;
  match.submitAction(actingPlayerId(match)!, hand.handNumber, action);
}

describe('lobby', () => {
  it('seats players in order and names the first joiner host', () => {
    const { match } = makeMatch({ players: 4 });
    expect(match.state.players.map((p) => p.seatIndex)).toEqual([0, 1, 2, 3]);
    expect(match.viewFor('p0').players[0]!.isHost).toBe(true);
  });

  it('refuses a seventh player', () => {
    const { match } = makeMatch({ players: 6 });
    expect(() => match.join('p6', 'Seven')).toThrow(MatchError);
    expect(() => match.join('p6', 'Seven')).toThrow(/seats 6/);
  });

  it('needs four ready players and the host to start', () => {
    const h = makeMatch({ players: 3 });
    expect(() => h.match.start('p0')).toThrow(/at least 4/);

    const four = makeMatch({ players: 4 });
    expect(() => four.match.start('p1')).toThrow(/host/);
    expect(() => four.match.start('p0')).toThrow(/ready/);
    expect(four.match.canStart()).toBe(false);

    for (const id of four.playerIds) four.match.setReady(id, true);
    expect(four.match.canStart()).toBe(true);
    four.match.start('p0');
    expect(four.match.state.status).toBe('IN_PROGRESS');
  });

  it('hands the host role on when the host leaves the lobby', () => {
    const { match } = makeMatch({ players: 4 });
    match.leave('p0');
    expect(match.state.hostPlayerId).toBe('p1');
    expect(match.state.players).toHaveLength(3);
  });

  it('turns leaving mid-match into a disconnect, keeping the seat and chips', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    h.match.leave('p1');
    const player = h.match.state.players.find((p) => p.playerId === 'p1')!;
    expect(player.connected).toBe(false);
    expect(player.seatIndex).toBe(1);
    expect(h.match.state.table!.seats.find((s) => s.seatIndex === 1)!.stack).toBeGreaterThan(0);
  });

  it('refuses a join once the match has begun', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    expect(() => h.match.join('p9', 'Late')).toThrow(/already begun/);
  });
});

describe('starting a match', () => {
  it('deals the first hand and asks somebody to act', () => {
    const h = readyAndStart(makeMatch({ players: 5 }));
    expect(h.match.state.phase).toBe('HAND_IN_PROGRESS');
    expect(h.match.state.table!.hand!.handNumber).toBe(1);
    expect(actingPlayerId(h.match)).not.toBeNull();
    expect(h.events.some((e) => e.type === 'MATCH_STARTED')).toBe(true);
    expect(h.events.some((e) => e.type === 'HAND_STARTED')).toBe(true);
  });

  it('starts the blind clock', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    const view = h.match.viewFor('p0');
    expect(view.level!.bigBlind).toBe(100);
    expect(view.level!.endsAt).toBeGreaterThan(view.serverTime);
  });
});

describe('submitting actions', () => {
  it('rejects an action from the wrong player', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    const wrong = h.playerIds.find((id) => id !== actingPlayerId(h.match))!;
    expect(() => h.match.submitAction(wrong, 1, { type: 'FOLD' })).toThrow(/not your turn/i);
  });

  it('rejects an action aimed at a hand that has ended', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    expect(() => h.match.submitAction(actingPlayerId(h.match)!, 99, { type: 'FOLD' })).toThrow(
      /has ended/,
    );
  });

  it('rejects an illegal action and keeps the same player on turn', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    const before = actingPlayerId(h.match);
    expect(() => actNow(h.match, { type: 'CHECK' })).toThrow(MatchError);
    expect(actingPlayerId(h.match)).toBe(before);
    // The clock was re-armed rather than left dead.
    expect(h.match.state.actionDeadline).toBeGreaterThan(h.clock.now());
  });

  it('rejects an action from somebody who is not in the match', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    expect(() => h.match.submitAction('nobody', 1, { type: 'FOLD' })).toThrow(/not in this match/);
  });

  it('advances the hand and eventually starts the next one', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    let guard = 0;
    while (h.match.state.table?.hand?.actingSeat !== null && guard++ < 20) {
      actNow(h.match, { type: 'FOLD' });
    }
    expect(h.match.state.table!.hand!.phase).toBe('COMPLETE');

    h.clock.advance(FAST.foldedHandDisplayMs + FAST.betweenHandsMs + 50);
    expect(h.match.state.table!.hand!.handNumber).toBe(2);
    expect(h.match.state.phase).toBe('HAND_IN_PROGRESS');
  });
});

describe('the action clock', () => {
  it('checks for a player who runs out of time when checking is free', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    // Fold around to the big blind, who can check.
    let guard = 0;
    while (guard++ < 10) {
      const hand = h.match.state.table!.hand!;
      if (hand.actingSeat === hand.bigBlindSeat) break;
      actNow(h.match, hand.currentBet > 0 ? { type: 'CALL' } : { type: 'CHECK' });
    }
    const bigBlind = h.match.state.table!.hand!.bigBlindSeat;
    expect(h.match.state.table!.hand!.actingSeat).toBe(bigBlind);

    h.clock.advance(FAST.actionTimeoutMs + 10);
    const timedOut = h.events.filter((e) => e.type === 'PLAYER_TIMED_OUT');
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]).toMatchObject({ seatIndex: bigBlind, forcedFold: false });
  });

  it('folds a player who runs out of time facing a bet', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    const seat = h.match.state.table!.hand!.actingSeat!;
    h.clock.advance(FAST.actionTimeoutMs + 10);
    expect(h.match.state.table!.hand!.seats.find((s) => s.seatIndex === seat)!.folded).toBe(true);
    expect(h.events.some((e) => e.type === 'PLAYER_TIMED_OUT' && e.forcedFold)).toBe(true);
  });

  it('shortens the clock for a disconnected player', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    const acting = actingPlayerId(h.match)!;
    const before = h.match.state.actionDeadline!;
    h.match.setConnected(acting, false);
    expect(h.match.state.actionDeadline).toBeLessThan(before);
    expect(h.match.state.actionDeadline! - h.clock.now()).toBe(FAST.disconnectedActionTimeoutMs);
  });

  it('gives the full clock back when they reconnect mid-turn', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    const acting = actingPlayerId(h.match)!;
    h.match.setConnected(acting, false);
    h.match.setConnected(acting, true);
    expect(h.match.state.actionDeadline! - h.clock.now()).toBe(FAST.actionTimeoutMs);
  });

  it('does not rush a disconnected player when the whole table has dropped', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    for (const id of h.playerIds) h.match.setConnected(id, false);
    expect(h.match.state.actionDeadline! - h.clock.now()).toBe(FAST.actionTimeoutMs);
  });
});

describe('reconnecting', () => {
  it('restores the same seat and the same hole cards', () => {
    const h = readyAndStart(makeMatch({ players: 5 }));
    const before = h.match.viewFor('p3');
    expect(before.you.holeCards).toHaveLength(2);

    h.match.setConnected('p3', false);
    h.match.setConnected('p3', true);

    const after = h.match.viewFor('p3');
    expect(after.you.seatIndex).toBe(before.you.seatIndex);
    expect(after.you.holeCards).toEqual(before.you.holeCards);
    expect(after.players.find((p) => p.playerId === 'p3')!.connected).toBe(true);
  });

  it('reports connection changes to everyone', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    h.match.setConnected('p2', false);
    expect(h.events).toContainEqual({
      type: 'PLAYER_CONNECTION',
      playerId: 'p2',
      connected: false,
    });
    expect(h.match.viewFor('p0').players.find((p) => p.playerId === 'p2')!.connected).toBe(false);
  });
});

describe('elimination and match end', () => {
  it('plays down to one survivor and assigns every finishing place', () => {
    const h = readyAndStart(makeMatch({ players: 6, structure: SHORT_STACKS, seed: 7 }));

    let guard = 0;
    while (h.match.state.status === 'IN_PROGRESS' && guard++ < 5_000) {
      const hand = h.match.state.table?.hand;
      if (h.match.state.phase === 'HAND_IN_PROGRESS' && hand && hand.actingSeat !== null) {
        actNow(h.match, { type: 'ALL_IN' });
      } else {
        h.clock.advance(100);
      }
    }

    expect(h.match.state.status).toBe('FINISHED');
    expect(h.match.state.phase).toBe('MATCH_END');
    expect(h.match.state.winnerPlayerId).not.toBeNull();

    const places = h.match.state.players.map((p) => p.place).sort((a, b) => a! - b!);
    expect(places).toEqual([1, 2, 3, 4, 5, 6]);

    const winner = h.match.state.players.find((p) => p.place === 1)!;
    expect(winner.playerId).toBe(h.match.state.winnerPlayerId);
    expect(winner.eliminatedAt).toBeNull();
  });

  it('leaves eliminated players at the table as empty chairs', () => {
    const h = readyAndStart(makeMatch({ players: 4, structure: SHORT_STACKS, seed: 3 }));
    let guard = 0;
    while (h.match.state.status === 'IN_PROGRESS' && guard++ < 5_000) {
      const hand = h.match.state.table?.hand;
      if (h.match.state.phase === 'HAND_IN_PROGRESS' && hand && hand.actingSeat !== null) {
        actNow(h.match, { type: 'ALL_IN' });
      } else {
        h.clock.advance(100);
      }
    }

    const view = h.match.viewFor('p0');
    // Everyone is still listed; the dead ones are marked, not removed.
    expect(view.players).toHaveLength(4);
    expect(view.players.filter((p) => !p.seated)).toHaveLength(3);
    expect(h.events.filter((e) => e.type === 'PLAYER_ELIMINATED')).toHaveLength(3);
    expect(h.events.some((e) => e.type === 'MATCH_ENDED')).toBe(true);
  });

  it('stops the blind clock when the match ends', () => {
    const h = readyAndStart(makeMatch({ players: 4, structure: SHORT_STACKS, seed: 5 }));
    let guard = 0;
    while (h.match.state.status === 'IN_PROGRESS' && guard++ < 5_000) {
      const hand = h.match.state.table?.hand;
      if (h.match.state.phase === 'HAND_IN_PROGRESS' && hand && hand.actingSeat !== null) {
        actNow(h.match, { type: 'ALL_IN' });
      } else {
        h.clock.advance(100);
      }
    }
    expect(h.match.state.clockRunningSince).toBeNull();
    const elapsed = h.match.state.clockElapsedMs;
    h.clock.advance(60_000);
    expect(h.match.state.clockElapsedMs).toBe(elapsed);
  });

  it('conserves chips across the whole match', () => {
    const h = readyAndStart(makeMatch({ players: 6, structure: SHORT_STACKS, seed: 11 }));
    const opening = h.match.state.table!.seats.reduce((s, x) => s + x.stack, 0);

    let guard = 0;
    while (h.match.state.status === 'IN_PROGRESS' && guard++ < 5_000) {
      const hand = h.match.state.table?.hand;
      if (h.match.state.phase === 'HAND_IN_PROGRESS' && hand && hand.actingSeat !== null) {
        actNow(h.match, { type: 'ALL_IN' });
      } else {
        h.clock.advance(100);
      }
    }
    expect(h.match.state.table!.seats.reduce((s, x) => s + x.stack, 0)).toBe(opening);
  });
});

describe('blind progression', () => {
  it('raises the blinds between hands as the clock runs', () => {
    const h = readyAndStart(makeMatch({ players: 4 }));
    expect(h.match.viewFor('p0').level!.level).toBe(1);

    // TURBO levels last 60 seconds. Fold hands until time has moved on.
    let guard = 0;
    while (h.match.state.status === 'IN_PROGRESS' && guard++ < 200) {
      const hand = h.match.state.table?.hand;
      if (h.match.state.phase === 'HAND_IN_PROGRESS' && hand && hand.actingSeat !== null) {
        actNow(h.match, { type: 'FOLD' });
      } else {
        h.clock.advance(20_000);
      }
      if (h.match.viewFor('p0').level!.level > 1) break;
    }

    expect(h.match.viewFor('p0').level!.level).toBeGreaterThan(1);
    expect(h.events.some((e) => e.type === 'BLIND_LEVEL_UP')).toBe(true);
  });
});
