import { describe, expect, it } from 'vitest';
import { STRESS, type BlindStructure, type MatchEvent } from '@cursed/shared';
import { SeededRandomSource } from '../poker/index.js';
import { ManualClock } from './clock.js';
import { createComposure } from './composure/index.js';
import { createDealer } from './dealer.js';
import { Match, MatchError } from './match.js';

/**
 * Playing again.
 *
 * A finished match used to be the end of the room: a banner, and six people
 * making a new lobby and passing a new code round. Now the host can lay the
 * table again — same room, same code, same people, and nothing else carried
 * over. These tests are mostly about that last part.
 */

const SHORT: BlindStructure = {
  id: 'short',
  label: 'Short',
  startingStackBigBlinds: 2,
  levels: [
    { level: 1, smallBlind: 50, bigBlind: 100, ante: 0, durationSeconds: 5 },
    { level: 2, smallBlind: 100, bigBlind: 200, ante: 0, durationSeconds: 36_000 },
  ],
};

const TIMINGS = {
  actionTimeoutMs: 30_000,
  disconnectedActionTimeoutMs: 5_000,
  showdownDisplayMs: 100,
  foldedHandDisplayMs: 100,
  betweenHandsMs: 100,
  runoutRevealMs: 50,
  runoutStreetMs: 50,
  runoutSettleMs: 50,
};

function table(players = 4) {
  const clock = new ManualClock();
  const events: MatchEvent[] = [];
  const match = new Match({
    roomCode: 'AGAIN2',
    hostPlayerId: 'p0',
    clock,
    rng: new SeededRandomSource(9),
    structure: SHORT,
    timings: TIMINGS,
  });
  match.onUpdate((batch) => events.push(...batch));
  const ids = Array.from({ length: players }, (_, i) => `p${i}`);
  for (const id of ids) match.join(id, `Player ${id}`);
  return { match, clock, events, ids };
}

function start(h: ReturnType<typeof table>): void {
  for (const player of h.match.state.players) h.match.setReady(player.playerId, true);
  h.match.start(h.match.state.hostPlayerId);
}

/** Everybody shoves every hand until one player has everything. */
function playOut(h: ReturnType<typeof table>): void {
  for (let guard = 0; h.match.state.status !== 'FINISHED' && guard < 5_000; guard++) {
    h.match.tick();
    const hand = h.match.state.table?.hand;
    const actor = h.match.state.players.find((p) => p.seatIndex === hand?.actingSeat);
    if (hand && actor) h.match.submitAction(actor.playerId, hand.handNumber, { type: 'ALL_IN' });
    else h.clock.advance(50);
  }
  expect(h.match.state.status).toBe('FINISHED');
}

function finished(players = 4) {
  const h = table(players);
  start(h);
  playOut(h);
  return h;
}

describe('playing again', () => {
  it('puts the same people back in the lobby, in the same chairs, under the same code', () => {
    const h = finished();
    const before = h.match.state.players.map((p) => [p.playerId, p.seatIndex, p.displayName]);

    h.match.rematch('p0');

    const state = h.match.state;
    expect(state.status).toBe('LOBBY');
    expect(state.phase).toBe('LOBBY');
    expect(state.roomCode).toBe('AGAIN2');
    expect(state.players.map((p) => [p.playerId, p.seatIndex, p.displayName])).toEqual(before);
    expect(state.hostPlayerId).toBe('p0');
  });

  it('brings back the ones who were taken', () => {
    const h = finished();
    expect(h.match.state.players.filter((p) => p.eliminatedAt !== null).length).toBeGreaterThan(0);

    h.match.rematch('p0');
    for (const player of h.match.state.players) {
      expect(player.eliminatedAt).toBeNull();
      expect(player.place).toBeNull();
      // Nobody is assumed to want another game: each of them says so again.
      expect(player.ready).toBe(false);
    }
    const view = h.match.viewFor('p1');
    expect(view.players.every((p) => p.seated)).toBe(true);
    expect(view.winnerPlayerId).toBeNull();
    expect(view.lastResult).toBeNull();
    expect(view.hand).toBeNull();
  });

  it('is the host\'s to ask for, and only once the game is over', () => {
    const lobby = table();
    expect(() => lobby.match.rematch('p0')).toThrow(MatchError);

    const playing = table();
    start(playing);
    expect(() => playing.match.rematch('p0')).toThrow(/not over/);

    const done = finished();
    expect(() => done.match.rematch('p2')).toThrow(/host/);
    expect(done.match.state.status).toBe('FINISHED');
  });

  it('does not wait for anybody who has gone', () => {
    const h = finished();
    h.match.setConnected('p2', false);
    h.match.rematch('p0');
    // Their chair is empty and somebody else can have it: a table held open
    // for a player who has closed the tab is a table that never starts.
    expect(h.match.state.players.map((p) => p.playerId)).toEqual(['p0', 'p1', 'p3']);
    const newcomer = h.match.join('p9', 'New');
    expect(newcomer.seatIndex).toBe(2);
  });

  it('hands the host\'s chair on if the host walks out of a finished game', () => {
    const h = finished();
    h.match.setConnected('p0', false);
    // Otherwise the only person who could lay the table again has left it.
    expect(h.match.state.hostPlayerId).toBe('p1');
    expect(h.match.viewFor('p1').players.find((p) => p.playerId === 'p1')!.isHost).toBe(true);
    h.match.rematch('p1');
    expect(h.match.state.status).toBe('LOBBY');
    expect(h.match.state.players.some((p) => p.playerId === 'p0')).toBe(false);
  });

  it('leaves the host alone while a game is still being played', () => {
    const h = table();
    start(h);
    h.match.setConnected('p0', false);
    expect(h.match.state.hostPlayerId).toBe('p0');
  });

  it('carries nothing over from the evening before', () => {
    const h = finished();
    // The first evening left its mark: chairs emptied, so the room turned.
    expect(h.match.presenceFor().dread).toBeGreaterThan(0.1);

    h.match.rematch('p0');
    start(h);

    const state = h.match.state;
    expect(state.table!.handNumber).toBe(1);
    expect(state.table!.levelIndex).toBe(0);
    expect(state.startingPlayers).toBe(4);
    // Full stacks, less whatever the first hand's blinds took.
    const chips = state.table!.hand!.seats.reduce((sum, seat) => sum + seat.stack + seat.totalCommitted, 0);
    expect(chips).toBe(4 * 200);

    const frame = h.match.presenceFor();
    expect(frame.dread).toBeLessThan(0.02);
    expect(frame.seats).toHaveLength(4);
    expect(frame.seats.every((seat) => !seat.composing)).toBe(true);

    // The blind clock started again from nothing.
    const view = h.match.viewFor('p0');
    expect(view.level!.level).toBe(1);
    expect(view.level!.endsAt! - view.serverTime).toBeGreaterThan(4_000);
  });

  it('starts the blinds again from the first level', () => {
    const h = table();
    start(h);
    // A long first hand: by the second, the blinds have gone up.
    h.clock.advance(6_000);
    playOut(h);
    expect(h.match.state.clockElapsedMs).toBeGreaterThan(5_000);

    h.match.rematch('p0');
    start(h);
    expect(h.match.state.clockElapsedMs).toBe(0);
    const view = h.match.viewFor('p0');
    expect(view.level!.level).toBe(1);
    // The whole of the first level is still ahead.
    expect(view.level!.endsAt! - view.serverTime).toBeGreaterThan(4_900);
  });

  it('puts the Dealer back where he began', () => {
    const h = finished();
    const worn = structuredClone(h.match.state.dealer);
    h.match.rematch('p0');
    // He spent the last evening dealing and watching; this one he has not begun.
    expect(h.match.state.dealer).toEqual(createDealer(h.clock.now()));
    expect(h.match.state.dealer).not.toEqual(worn);
  });

  it('forgets who was steadying themselves, and who had just failed to', () => {
    const h = table();
    start(h);
    h.match.beginComposure('p1');
    h.match.beginComposure('p2');
    expect(h.match.state.composure.seats.length).toBe(2);
    playOut(h);

    h.match.rematch('p0');
    expect(h.match.state.composure).toEqual(createComposure());
    start(h);
    // No cooldown inherited from an evening that is over.
    expect(() => h.match.beginComposure('p1')).not.toThrow();
  });

  it('gives everybody their nerve back', () => {
    const h = finished();
    h.match.rematch('p0');
    for (const id of h.ids) {
      const { stress } = h.match.selfFor(id);
      // Before the first card of a new evening nobody has anything to fear yet.
      expect(stress.heartRate).toBeLessThan(STRESS.restingBpm + 3);
    }
  });

  it('can be played to the end again, and again', () => {
    const h = finished();
    for (let evening = 0; evening < 3; evening++) {
      h.match.rematch(h.match.state.hostPlayerId);
      start(h);
      playOut(h);
      const winners = h.match.state.players.filter((p) => p.place === 1);
      expect(winners).toHaveLength(1);
      expect(h.match.state.winnerPlayerId).toBe(winners[0]!.playerId);
    }
  });

  it('says so, to the whole table', () => {
    const h = finished();
    h.events.length = 0;
    h.match.rematch('p0');
    expect(h.events.map((event) => event.type)).toContain('MATCH_RESET');
  });

  it('leaves no clock running from the game before', () => {
    const h = finished();
    h.match.rematch('p0');
    const before = h.events.length;
    // An hour in a lobby and nothing happens by itself.
    h.clock.advance(60 * 60 * 1000);
    expect(h.events.length).toBe(before);
    expect(h.match.state.status).toBe('LOBBY');
  });
});
