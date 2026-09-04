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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const COLORS = { server: '\x1b[35m', client: '\x1b[36m', reset: '\x1b[0m' };
const useColor = process.stdout.isTTY;

const children = [];
let shuttingDown = false;

function start(name, args) {
  const child = spawn(npm, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
