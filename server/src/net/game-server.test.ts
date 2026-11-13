import { describe, expect, it } from 'vitest';
import type { ClientView } from '@cursed/shared';
import { ManualClock } from '../match/clock.js';
import { GameServer } from './game-server.js';
import type { AckFn, Connection, InboundHandler, ServerMessageName, ServerPayload, Transport } from './transport.js';

/**
 * The game server, driven directly.
 *
 * `tests/integration.test.ts` covers the same server over real sockets, which is
 * the right way to prove the wire works and the wrong way to pin down a corner
 * of the bookkeeping: these are the cases about *which connection speaks for
 * which seat*, and they want a transport that does exactly what it is told and
 * a clock that does not move on its own.
 */

class FakeConnection implements Connection {
  readonly sent: { name: string; payload: unknown }[] = [];
  closed = false;
  #onMessage: InboundHandler = () => {};
  #onClose: () => void = () => {};

  constructor(
    readonly id: string,
    readonly remoteAddress: string,
  ) {}

  send<K extends ServerMessageName>(name: K, payload: ServerPayload<K>): void {
    this.sent.push({ name, payload });
  }

  onMessage(handler: InboundHandler): void {
    this.#onMessage = handler;
  }

  onClose(handler: () => void): void {
    this.#onClose = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#onClose();
  }

  /** A message with an acknowledgement; returns what the server replied. */
  request(name: string, payload: unknown = {}): any {
    let reply: unknown;
    const ack: AckFn = (response) => {
      reply = response;
    };
    this.#onMessage(name, payload, ack);
    return reply;
  }

  /** The newest view this connection was sent, if any. */
  get view(): ClientView | null {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]!.name === 'view') return this.sent[i]!.payload as ClientView;
    }
    return null;
  }

  count(name: string): number {
    return this.sent.filter((message) => message.name === name).length;
  }
}

class FakeTransport implements Transport {
  #handler: ((connection: Connection) => void) | null = null;
  #next = 1;

  onConnection(handler: (connection: Connection) => void): void {
    this.#handler = handler;
  }

  async close(): Promise<void> {}

  /** Every connection from its own address, so the join limiter stays out of the way. */
  connect(): FakeConnection {
    const id = this.#next++;
    const connection = new FakeConnection(`c${id}`, `10.0.0.${id}`);
    this.#handler?.(connection);
    return connection;
  }
}

function harness(options: { onInternalError?: (error: unknown, message: string) => void } = {}) {
  const clock = new ManualClock();
  const transport = new FakeTransport();
  const server = new GameServer({
    transport,
    clock,
    // No presence tick: these tests count views, and a ticking Dealer is noise.
    presenceHz: 0,
    sessionSecret: 'a-secret-long-enough-for-tests',
    ...options,
  });
  return { clock, transport, server };
}

/** Four players in one lobby, all ready, the first one hosting. */
function fullLobby(h: ReturnType<typeof harness>) {
  const host = h.transport.connect();
  const grant = host.request('lobby:create', { displayName: 'Host' });
  const others = ['B', 'C', 'D'].map((name) => {
    const connection = h.transport.connect();
    expect(connection.request('lobby:join', { code: grant.roomCode, displayName: name }).ok).toBe(true);
    return connection;
  });
  const all = [host, ...others];
  for (const connection of all) connection.request('lobby:ready', { ready: true });
  return { host, others, all, code: grant.roomCode as string };
}

describe('one connection, one seat', () => {
  it('leaves the first lobby when it opens a second', () => {
    const h = harness();
    const connection = h.transport.connect();
    const first = connection.request('lobby:create', { displayName: 'Mara' });
    const second = connection.request('lobby:create', { displayName: 'Mara' });
    expect(first.ok && second.ok).toBe(true);
    expect(second.roomCode).not.toBe(first.roomCode);

    // The seat it walked away from is empty, not held by a ghost that reads as
    // connected for ever — which would also keep the room from being swept.
    const abandoned = h.server.rooms.get(first.roomCode)!;
    expect(abandoned.match.state.players).toHaveLength(0);

    h.clock.advance(11 * 60 * 1000);
    h.server.sweep();
    expect(h.server.rooms.get(first.roomCode)).toBeUndefined();
    expect(h.server.rooms.get(second.roomCode)).toBeDefined();
  });

  it('stops hearing about a table it has walked away from', () => {
    const h = harness();
    const { host, others, code } = fullLobby(h);
    expect(host.request('lobby:start').ok).toBe(true);

    const wanderer = others[0]!;
    expect(wanderer.request('lobby:create', { displayName: 'B' }).ok).toBe(true);

    // Mid-match the chair and its chips stay; the player is simply away.
    const match = h.server.rooms.get(code)!.match;
    const seat = match.state.players.find((p) => p.displayName === 'B')!;
    expect(seat.connected).toBe(false);

    // And nothing more from the old table reaches the connection that left it.
    const before = wanderer.count('view');
    const hand = match.state.table!.hand!;
    const actor = match.state.players.find((p) => p.seatIndex === hand.actingSeat)!;
    match.submitAction(actor.playerId, hand.handNumber, { type: 'FOLD' });
    expect(wanderer.count('view')).toBe(before);
  });

  it('closing afterwards disconnects the seat it actually holds', () => {
    const h = harness();
    const connection = h.transport.connect();
    connection.request('lobby:create', { displayName: 'Mara' });
    const second = connection.request('lobby:create', { displayName: 'Mara' });
    connection.close();
    expect(h.server.rooms.get(second.roomCode)!.match.state.players).toHaveLength(0);
  });
});

describe('a lobby everybody left', () => {
  it('gives the host chair to whoever arrives next', () => {
    const h = harness();
    const first = h.transport.connect();
    const grant = first.request('lobby:create', { displayName: 'Gone' });
    first.close();

    const next = h.transport.connect();
    expect(next.request('lobby:join', { code: grant.roomCode, displayName: 'Here' }).ok).toBe(true);
    const me = next.view!.players.find((p) => p.playerId === next.view!.you.playerId)!;
    // Without this the lobby can never be started: its host is nobody.
    expect(me.isHost).toBe(true);
  });
});

describe('looking at your own cards', () => {
  it('tells the one who looked, and nobody else', () => {
    const h = harness();
    const { host, all } = fullLobby(h);
    host.request('lobby:start');

    const looker = all[2]!;
    const handNumber = looker.view!.hand!.handNumber;
    const before = all.map((connection) => connection.count('view'));

    expect(looker.request('poker:peek', { handNumber }).ok).toBe(true);
    expect(looker.view!.you.holeCards).toHaveLength(2);

    // A view landing on everybody's screen the instant somebody first looked
    // would be a second, exact copy of a tell the table is only supposed to get
    // by watching — and it rebuilt five other players' overlays for nothing.
    all.forEach((connection, index) => {
      expect(connection.count('view') - before[index]!).toBe(connection === looker ? 1 : 0);
    });
  });
});

describe('when the server itself breaks', () => {
  it('says so without saying how, and writes it down', () => {
    const reported: { error: unknown; message: string }[] = [];
    const h = harness({ onInternalError: (error, message) => reported.push({ error, message }) });
    const connection = h.transport.connect();
    const grant = connection.request('lobby:create', { displayName: 'Mara' });

    const match = h.server.rooms.get(grant.roomCode)!.match;
    match.setReady = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'deck')");
    };

    const reply = connection.request('lobby:ready', { ready: true });
    expect(reply).toMatchObject({ ok: false, code: 'INTERNAL' });
    // The text of an exception is a description of the inside of the server.
    expect(reply.message).not.toMatch(/deck|undefined|properties/);
    expect(reported).toHaveLength(1);
    expect(reported[0]!.message).toBe('lobby:ready');
    expect(String(reported[0]!.error)).toMatch(/deck/);
  });

  it('still explains a refusal the game itself made', () => {
    const h = harness();
    const connection = h.transport.connect();
    connection.request('lobby:create', { displayName: 'Mara' });
    const reply = connection.request('lobby:start');
    expect(reply).toMatchObject({ ok: false, code: 'NOT_ENOUGH_PLAYERS' });
    expect(reply.message).toMatch(/at least/);
  });
});
