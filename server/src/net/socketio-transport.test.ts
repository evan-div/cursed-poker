import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketIoServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { GameServer } from './game-server.js';
import { SocketIoTransport } from './socketio-transport.js';

/**
 * Rate limiting, behind a proxy and not, over real sockets.
 *
 * Every connection in this file comes from 127.0.0.1, which is exactly the
 * position a server behind a reverse proxy is in: everybody has the proxy's
 * address. What differs is the header the "proxy" sets, and whether the server
 * was told to believe it.
 */

let http: HttpServer | null = null;
let game: GameServer | null = null;
const sockets: ClientSocket[] = [];

async function start(trustedProxies: number): Promise<number> {
  http = createServer();
  const io = new SocketIoServer(http);
  game = new GameServer({
    transport: new SocketIoTransport(io, { trustedProxies }),
    sessionSecret: 'a-secret-long-enough-for-tests',
    presenceHz: 0,
    // One lobby a minute from any one address, so the second is the test.
    joinsPerMinute: 1,
  });
  await new Promise<void>((resolve) => http!.listen(0, '127.0.0.1', resolve));
  return (http.address() as AddressInfo).port;
}

/** Opens a lobby as a client whose request carried `forwardedFor`. */
async function openLobby(port: number, forwardedFor?: string): Promise<{ ok: boolean; code?: string }> {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    ...(forwardedFor ? { extraHeaders: { 'x-forwarded-for': forwardedFor } } : {}),
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return new Promise((resolve) => socket.emit('lobby:create', { displayName: 'Mara' }, resolve));
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await game?.close();
  await new Promise((resolve) => (http ? http.close(resolve) : resolve(undefined)));
  http = null;
  game = null;
});

describe('whose budget a connection spends', () => {
  it('is everybody\'s, behind a proxy the server was not told about', async () => {
    const port = await start(0);
    expect((await openLobby(port, '203.0.113.1')).ok).toBe(true);
    // A different person, as far as the header goes — and the same address as
    // far as the server can tell. This is the problem the setting solves.
    expect(await openLobby(port, '203.0.113.2')).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  });

  it('is each player\'s own, once the proxy is trusted', async () => {
    const port = await start(1);
    expect((await openLobby(port, '203.0.113.1')).ok).toBe(true);
    expect((await openLobby(port, '203.0.113.2')).ok).toBe(true);
    // And the same player again is still one player.
    expect(await openLobby(port, '203.0.113.1')).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  });

  it('cannot be reset by sending a header of your own', async () => {
    const port = await start(1);
    // The proxy appends the real address; whatever the client put in front of
    // it is the client's own invention.
    expect((await openLobby(port, '6.6.6.6, 203.0.113.9')).ok).toBe(true);
    expect(await openLobby(port, '7.7.7.7, 203.0.113.9')).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  });

  it('ignores the header entirely when no proxy is trusted', async () => {
    const port = await start(0);
    expect((await openLobby(port)).ok).toBe(true);
    // Without this a server reached directly could be guessed at without limit:
    // a new made-up address for every attempt.
    expect(await openLobby(port, '8.8.8.8')).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
  });
});
