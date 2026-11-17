import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIoServer } from 'socket.io';
import type { BlindStructure } from '@cursed/shared';
import { ConfigError, readConfig, type ServerConfig } from './config.js';
import { GameServer } from './net/game-server.js';
import { SocketIoTransport } from './net/socketio-transport.js';
import { createStaticHandler, type StaticHandler } from './net/static.js';
import { DirectorySink } from './net/stress-log-sink.js';

/**
 * The server's entry point, for a desk and for a deployment.
 *
 * At a desk it serves only the socket: the client runs on Vite, on another
 * port, and talks to this across origins. Deployed (`npm start`, or
 * `--production`) it is the whole game in one process — the built client and
 * the socket from the same origin, on one port — which is what makes it
 * something four friends in four houses can open a link to.
 *
 * One origin is the point. There is no second service to deploy, no address to
 * bake into the client and no cross-origin setting to get wrong; the page asks
 * for a socket from wherever the page came from.
 */

/** Where `npm run build` leaves the client, relative to this file. */
const BUILT_CLIENT = fileURLToPath(new URL('../../client/dist', import.meta.url));

function configure(): ServerConfig {
  try {
    return readConfig(process.env, process.argv.slice(2), { clientDist: BUILT_CLIENT });
  } catch (error) {
    // A setting that makes no sense is said once, plainly, and nothing starts.
    if (error instanceof ConfigError) {
      console.error(`[cursed-poker] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

const config = configure();

/**
 * The built client, if this process is serving one.
 *
 * In production it has to be there, unless the client has been told to live
 * somewhere else (`CLIENT_ORIGIN`): a server that starts happily and answers
 * every page with "not found" is the kind of mistake that looks like an outage.
 */
function clientFiles(): StaticHandler | null {
  if (!config.clientDist) return null;
  if (existsSync(join(config.clientDist, 'index.html'))) return createStaticHandler(config.clientDist);
  if (config.production && !config.clientOrigin) {
    console.error(
      `[cursed-poker] No built client at ${config.clientDist}. Run \`npm run build\` first, ` +
        'or set CLIENT_ORIGIN if the client is hosted somewhere else.',
    );
    process.exit(1);
  }
  return null;
}

const serveClient = clientFiles();

/**
 * Which other origins may talk to this server.
 *
 * With `CLIENT_ORIGIN` set, that origin and nothing else. Without it, at a desk,
 * any loopback origin — the dev UI is legitimately on a different port — and in
 * production none, because the client is served from here and needs no
 * permission to talk to its own origin. Getting this wrong is quiet and
 * confusing: the page loads, the socket is refused, and the only symptom is
 * "offline".
 */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const corsOrigin = (
  origin: string | undefined,
  callback: (error: Error | null, allowed?: boolean) => void,
): void => {
  if (!origin) return callback(null, true); // same-origin or a non-browser client
  if (config.clientOrigin) return callback(null, origin === config.clientOrigin);
  callback(null, !config.production && LOOPBACK.test(origin));
};

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: gameServer.rooms.size }));
    return;
  }

  const notFound = (): void => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  };
  if (!serveClient) return notFound();
  serveClient(req, res).then(
    (handled) => {
      if (!handled) notFound();
    },
    () => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    },
  );
});

const io = new SocketIoServer(httpServer, {
  cors: { origin: corsOrigin, credentials: true },
  // A poker action is tiny. Anything larger is not a poker action.
  maxHttpBufferSize: 8 * 1024,
});

/**
 * A short match, for working on everything that happens *after* the poker.
 *
 * Sacrifices, eliminations, the Dealer taking someone away — none of it is
 * reachable in a 60-90 minute match you have to play out by hand. `DEV_FAST=1`
 * gives everyone two big blinds and a fast clock, so the interesting states
 * arrive in under a minute.
 */
const FAST_STRUCTURE: BlindStructure = {
  id: 'dev-fast',
  label: 'Development (short stacks)',
  startingStackBigBlinds: 3,
  levels: [{ level: 1, smallBlind: 50, bigBlind: 100, ante: 0, durationSeconds: 600 }],
};

/**
 * How long a player has to act, overridable.
 *
 * Thirty seconds is right for people. It is far too short for a tool that drives
 * browsers around the table taking screenshots — `npm run shots` spends most of
 * a hand just setting the lobby up, and every capture landed on an empty felt
 * because the player it was photographing had been folded out by the clock.
 *
 * Merged rather than spread twice: two `timings` keys in one object literal
 * means the second one wins outright, quietly undoing DEV_FAST's other clocks.
 */
const timings = {
  ...(config.fast
    ? {
        actionTimeoutMs: 8_000,
        showdownDisplayMs: 2_500,
        betweenHandsMs: 1_200,
        runoutRevealMs: 900,
        runoutStreetMs: 1_100,
        runoutSettleMs: 700,
      }
    : {}),
  ...(config.actionTimeoutMs > 0 ? { actionTimeoutMs: config.actionTimeoutMs } : {}),
};

/**
 * Recording what the stress model was fed, match by match, for `npm run
 * stress -- --log`. Off unless asked for. The files hold no cards, no names and
 * no lobby codes — see `stress-telemetry.ts` — but they are still a record of
 * how people played, so keeping them is a choice somebody makes on purpose.
 */
const gameServer = new GameServer({
  transport: new SocketIoTransport(io, { trustedProxies: config.trustedProxies }),
  ...(config.sessionSecret ? { sessionSecret: config.sessionSecret } : {}),
  ...(config.fast ? { structure: FAST_STRUCTURE } : {}),
  ...(Object.keys(timings).length > 0 ? { timings } : {}),
  ...(config.stressTelemetryDir ? { stressLogs: new DirectorySink(config.stressTelemetryDir) } : {}),
});

if (config.stressTelemetryDir) {
  console.log(`[cursed-poker] recording stress telemetry to ${config.stressTelemetryDir}`);
}
if (config.fast) console.log('[cursed-poker] DEV_FAST: three big blinds each, short clocks');
if (config.actionTimeoutMs > 0) {
  console.log(`[cursed-poker] action clock overridden to ${config.actionTimeoutMs}ms`);
}
if (config.trustedProxies > 0) {
  console.log(
    `[cursed-poker] trusting ${config.trustedProxies} reverse ${config.trustedProxies === 1 ? 'proxy' : 'proxies'} ` +
      'for client addresses',
  );
}

if (!config.sessionSecret) {
  console.warn(
    '[cursed-poker] SESSION_SECRET is not set; using a random secret. ' +
      'Sessions will not survive a restart.',
  );
}

const sweeper = setInterval(() => gameServer.sweep(), 60_000);
sweeper.unref();

httpServer.listen(config.port, () => {
  const accepting = config.clientOrigin ?? (config.production ? 'its own origin only' : 'any localhost origin');
  console.log(`[cursed-poker] listening on :${config.port} (accepting ${accepting})`);
  if (serveClient) {
    console.log(`[cursed-poker] serving the game from ${config.clientDist} — open http://localhost:${config.port}`);
    // Rooms live in memory. Said at every start, because the first time it
    // matters is the first time somebody deploys in the middle of an evening.
    console.log('[cursed-poker] matches are held in memory: restarting this process ends any in progress');
  } else {
    console.log('[cursed-poker] open the dev UI at http://localhost:5173');
  }
});

const shutdown = async () => {
  clearInterval(sweeper);
  await gameServer.close();
  httpServer.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
