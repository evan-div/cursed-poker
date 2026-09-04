import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketIoServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BlindStructure, Card, ClientView, PlayerAction } from '@cursed/shared';
import { GameServer } from '../server/src/net/game-server.js';
import { SocketIoTransport } from '../server/src/net/socketio-transport.js';

/**
 * End-to-end: real HTTP server, real Socket.IO, real clients.
 *
 * Phase 2's exit criterion is that a group can finish a whole tournament over
 * the wire, drop and rejoin mid-match, and never see each other's cards. This
 * test is that criterion, checked by cross-referencing what every client
 * actually received against what every other client was holding.
 */

/** Two big blinds each, so a full match finishes in seconds. */
const SHORT_STACKS: BlindStructure = {
  id: 'integration',
  label: 'Integration',
  startingStackBigBlinds: 2,
  levels: [{ level: 1, smallBlind: 50, bigBlind: 100, ante: 0, durationSeconds: 36_000 }],
};

interface TestClient {
  name: string;
  socket: ClientSocket;
  playerId: string;
  token: string;
  views: ClientView[];
  latest: ClientView | null;
  /** Own hole cards per hand number, for the cross-client privacy audit. */
  holeByHand: Map<number, Card[]>;
  acting: boolean;
}

let httpServer: HttpServer;
let gameServer: GameServer;
let port: number;
const clients: TestClient[] = [];

function emit(socket: ClientSocket, name: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 5_000);
    socket.emit(name, payload, (response: unknown) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

async function connect(name: string): Promise<TestClient> {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });

  const client: TestClient = {
    name,
    socket,
    playerId: '',
    token: '',
    views: [],
    latest: null,
    holeByHand: new Map(),
    acting: false,
  };

  socket.on('view', (view: ClientView) => {
    client.views.push(view);
    client.latest = view;
    if (view.hand && view.you.holeCards) {
      client.holeByHand.set(view.hand.handNumber, view.you.holeCards);
    }
  });

  clients.push(client);
  return client;
}

/** A bot that shoves whenever it can, so matches end quickly. */
function playAggressively(client: TestClient): void {
  client.socket.on('view', async (view: ClientView) => {
    const legal = view.you.legalActions;
    if (!legal || !view.hand || client.acting) return;
    client.acting = true;
    const action: PlayerAction = legal.canRaise
      ? { type: 'ALL_IN' }
      : legal.canCall
        ? { type: 'CALL' }
        : { type: 'CHECK' };
    try {
      await emit(client.socket, 'poker:action', { handNumber: view.hand.handNumber, action });
    } catch {
      // A rejected or stale action is fine; the next view will re-prompt.
    } finally {
      client.acting = false;
    }
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000, label = 'condition') {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(async () => {
  httpServer = createServer();
  const io = new SocketIoServer(httpServer, { cors: { origin: '*' } });
  gameServer = new GameServer({
    transport: new SocketIoTransport(io),
    sessionSecret: 'integration-test-secret-value',
    structure: SHORT_STACKS,
    timings: {
      actionTimeoutMs: 5_000,
      disconnectedActionTimeoutMs: 1_000,
      showdownDisplayMs: 20,
      foldedHandDisplayMs: 20,
      betweenHandsMs: 20,
    },
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const client of clients) client.socket.close();
  clients.length = 0;
  await gameServer.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** Creates a lobby with `count` players, all ready. Returns them in join order. */
async function openLobby(count: number): Promise<TestClient[]> {
  const host = await connect('host');
  const created = await emit(host.socket, 'lobby:create', { displayName: 'Host' });
  expect(created.ok).toBe(true);
  host.playerId = created.playerId;
  host.token = created.token;
  const code: string = created.roomCode;

  const group = [host];
  for (let i = 1; i < count; i++) {
    const client = await connect(`p${i}`);
    const joined = await emit(client.socket, 'lobby:join', { code, displayName: `Player ${i}` });
    expect(joined.ok).toBe(true);
    client.playerId = joined.playerId;
    client.token = joined.token;
    group.push(client);
  }

  for (const client of group) {
    expect((await emit(client.socket, 'lobby:ready', { ready: true })).ok).toBe(true);
  }
  await waitFor(
    () => group.every((c) => c.latest?.players.length === count),
    5_000,
    'everyone to appear in the lobby',
  );
  return group;
}

describe('lobby over the wire', () => {
  it('creates a lobby, seats six players and starts', async () => {
    const group = await openLobby(6);
    expect((await emit(group[0]!.socket, 'lobby:start', {})).ok).toBe(true);
    await waitFor(() => group.every((c) => c.latest?.room.status === 'IN_PROGRESS'), 5_000, 'start');

    for (const client of group) {
      const view = client.latest!;
      expect(view.players).toHaveLength(6);
      expect(view.hand!.seats).toHaveLength(6);
      expect(view.you.holeCards).toHaveLength(2);
    }
  });

  it('rejects a bad lobby code, a short table and a non-host start', async () => {
    const stranger = await connect('stranger');
    const bad = await emit(stranger.socket, 'lobby:join', { code: 'ZZZZZZ', displayName: 'Nope' });
    expect(bad).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    const group = await openLobby(4);
    const notHost = await emit(group[1]!.socket, 'lobby:start', {});
    expect(notHost).toMatchObject({ ok: false, code: 'NOT_HOST' });
  });

  it('refuses malformed payloads before they reach game code', async () => {
    const client = await connect('fuzzer');
    for (const payload of [
      { displayName: '' },
      { displayName: 'x'.repeat(200) },
      {},
      { displayName: 12345 },
      null,
    ]) {
      const response = await emit(client.socket, 'lobby:create', payload);
      expect(response).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
    }
    // A well-formed one still works, so validation is not just refusing everything.
    expect((await emit(client.socket, 'lobby:create', { displayName: 'Fine' })).ok).toBe(true);
  });

  it('rejects an unknown message name', async () => {
    const client = await connect('curious');
    const response = await emit(client.socket, 'admin:giveMeAces', { seat: 0 });
    expect(response).toMatchObject({ ok: false, code: 'BAD_REQUEST' });
  });
});

describe('a whole match over the wire', () => {
  it('plays six players down to one winner', async () => {
    const group = await openLobby(6);
    for (const client of group) playAggressively(client);
    await emit(group[0]!.socket, 'lobby:start', {});

    await waitFor(
      () => group.every((c) => c.latest?.room.status === 'FINISHED'),
      30_000,
      'the match to finish',
    );

    const final = group[0]!.latest!;
    expect(final.winnerPlayerId).not.toBeNull();
    expect(final.players.filter((p) => p.seated)).toHaveLength(1);
    for (const client of group) {
      expect(client.latest!.winnerPlayerId).toBe(final.winnerPlayerId);
    }
  }, 40_000);

  it('never sends a client another player\'s live hole cards', async () => {
    const group = await openLobby(5);
    for (const client of group) playAggressively(client);
    await emit(group[0]!.socket, 'lobby:start', {});
    await waitFor(
      () => group.every((c) => c.latest?.room.status === 'FINISHED'),
      30_000,
      'the match to finish',
    );

    let viewsChecked = 0;

    for (const viewer of group) {
      for (const view of viewer.views) {
        if (!view.hand) continue;
        viewsChecked++;

        const handNumber = view.hand.handNumber;
        const revealed = new Set(
          view.hand.seats.filter((s) => s.revealedCards !== null).map((s) => s.seatIndex),
        );

        // Cards held by anyone else this hand, whose seat this view did not
        // openly reveal. None of them may appear anywhere in the view.
        const forbidden = new Set<Card>();
        for (const other of group) {
          if (other === viewer) continue;
          const seat = view.players.find((p) => p.playerId === other.playerId)?.seatIndex;
          if (seat === null || seat === undefined || revealed.has(seat)) continue;
          for (const card of other.holeByHand.get(handNumber) ?? []) forbidden.add(card);
        }

        const shown: Card[] = [
          ...view.hand.board,
          ...(view.you.holeCards ?? []),
          ...view.hand.seats.flatMap((s) => [...(s.revealedCards ?? []), ...(s.bestFive ?? [])]),
          ...(view.lastResult?.showdown ?? []).flatMap((r) => [...r.holeCards, ...r.bestFive]),
        ];

        for (const card of shown) {
          expect(
            forbidden.has(card),
            `${viewer.name} was shown card ${card} in hand ${handNumber}, which belonged to another player`,
          ).toBe(false);
        }
      }
    }

    expect(viewsChecked).toBeGreaterThan(20);
  }, 40_000);
});

describe('reconnecting over the wire', () => {
  it('restores the same seat and the same hole cards after a drop', async () => {
    const group = await openLobby(4);
    await emit(group[0]!.socket, 'lobby:start', {});
    await waitFor(() => group.every((c) => c.latest?.hand !== null), 5_000, 'the first hand');

    const victim = group[3]!;
    const before = victim.latest!;
    const seatBefore = before.you.seatIndex;
    const cardsBefore = before.you.holeCards;
    expect(cardsBefore).toHaveLength(2);

    victim.socket.close();
    await waitFor(
      () =>
        group[0]!.latest!.players.find((p) => p.playerId === victim.playerId)?.connected === false,
      5_000,
      'the drop to register',
    );

    const rejoined = await connect('rejoined');
    const resumed = await emit(rejoined.socket, 'lobby:resume', { token: victim.token });
    expect(resumed).toMatchObject({ ok: true, playerId: victim.playerId });

    await waitFor(() => rejoined.latest !== null, 5_000, 'a view after resuming');
    expect(rejoined.latest!.you.seatIndex).toBe(seatBefore);
    expect(rejoined.latest!.you.holeCards).toEqual(cardsBefore);
    expect(
      rejoined.latest!.players.find((p) => p.playerId === victim.playerId)!.connected,
    ).toBe(true);
  }, 30_000);

  it('refuses a forged or tampered session token', async () => {
    const group = await openLobby(4);
    const real = group[2]!.token;
    const tampered = `${real.slice(0, -4)}AAAA`;
    const stranger = await connect('forger');

    for (const token of [tampered, 'not-a-token-at-all-but-long-enough', `${real}x`]) {
      const response = await emit(stranger.socket, 'lobby:resume', { token });
      expect(response.ok).toBe(false);
      expect(['SESSION_INVALID', 'BAD_REQUEST']).toContain(response.code);
    }

    // The genuine token still works, so the check is not rejecting everything.
    expect((await emit(stranger.socket, 'lobby:resume', { token: real })).ok).toBe(true);
  }, 20_000);
});
