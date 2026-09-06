#!/usr/bin/env node
/**
 * Runs the server and the dev UI together.
 *
 * Both are long-running, so running them by hand means two terminals and
 * remembering to stop both. This starts them side by side, prefixes their
 * output so it is obvious which is which, and takes both down together — if
 * either dies, the other should not be left running against nothing.
 *
 * Use `npm run dev:server` / `npm run dev:client` separately when you want to
 * restart one without the other.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * A session secret that survives a restart.
 *
 * Without one the server generates a random secret at boot, so every restart
 * invalidates every reconnect token: the tab says "Connection lost" and then
 * cannot rejoin the lobby it was sitting in. During development the server
 * restarts whenever a source file is saved, which made a five-second edit cost
 * a whole lobby.
 *
 * Generated once and kept in a gitignored file rather than hardcoded, so there
 * is no secret in the repository and no shared value between machines. It is a
 * development convenience only — production still sets `SESSION_SECRET`.
 */
function devSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  const file = join(root, '.dev-session-secret');
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored.length >= 32) return stored;
  }

  const generated = randomBytes(32).toString('hex');
  writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  return generated;
}

const sessionSecret = devSessionSecret();

const COLORS = { server: '\x1b[35m', client: '\x1b[36m', reset: '\x1b[0m' };
const useColor = process.stdout.isTTY;

const children = [];
let shuttingDown = false;

function start(name, args) {
  const child = spawn(npm, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SESSION_SECRET: sessionSecret },
  });
  const tint = useColor ? COLORS[name] : '';
  const reset = useColor ? COLORS.reset : '';
  const label = `${tint}[${name}]${reset}`;

  const forward = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      // npm's own banner lines are noise once two processes are interleaved.
      for (const line of lines) {
        if (line.trim() === '' || line.startsWith('> ')) continue;
        target.write(`${label} ${line}\n`);
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    process.stdout.write(`${label} exited (${code}); stopping the other process.\n`);
    shutdown(code ?? 1);
  });

  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('server', ['--workspace', '@cursed/server', 'run', 'dev']);
start('client', ['--workspace', '@cursed/client', 'run', 'dev']);

process.stdout.write('\nCursed Poker — dev UI on http://localhost:5173, server on :3001\n');
process.stdout.write('Open four to six tabs. Ctrl-C stops both.\n\n');
