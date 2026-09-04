import { createServer } from 'node:http';
import { Server as SocketIoServer } from 'socket.io';
import { GameServer } from './net/game-server.js';
import { SocketIoTransport } from './net/socketio-transport.js';

/**
 * Development entry point.
 *
 * Serves nothing but the socket: the dev UI runs on Vite and talks to this over
 * CORS. Production packaging is a Phase 3 concern.
 */

const PORT = Number(process.env.PORT ?? 3001);
const ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: gameServer.rooms.size }));
    return;
  }
  res.writeHead(404).end();
});

const io = new SocketIoServer(httpServer, {
  cors: { origin: ORIGIN, credentials: true },
  // A poker action is tiny. Anything larger is not a poker action.
  maxHttpBufferSize: 8 * 1024,
});

const gameServer = new GameServer({
  transport: new SocketIoTransport(io),
  ...(process.env.SESSION_SECRET ? { sessionSecret: process.env.SESSION_SECRET } : {}),
});

if (!process.env.SESSION_SECRET) {
  console.warn(
    '[cursed-poker] SESSION_SECRET is not set; using a random secret. ' +
      'Sessions will not survive a restart.',
  );
}

const sweeper = setInterval(() => gameServer.sweep(), 60_000);
sweeper.unref();

httpServer.listen(PORT, () => {
  console.log(`[cursed-poker] listening on :${PORT} (client origin ${ORIGIN})`);
});

const shutdown = async () => {
  clearInterval(sweeper);
  await gameServer.close();
  httpServer.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
