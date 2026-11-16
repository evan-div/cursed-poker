import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

/**
 * Serves the built client.
 *
 * So that the whole game is one process on one port: the page, its scripts and
 * the socket all come from the same origin, there is no second thing to deploy
 * and no cross-origin setting to get wrong. It is a few dozen lines rather than
 * a dependency because what it serves is three files that never change while it
 * is running.
 *
 * **This is the only code in the server that opens a path somebody else
 * chose.** Everything else a client sends is a message, parsed by a schema.
 * This is a string that becomes a filename, so the rules are short and each
 * one is there to stop a specific way out:
 *
 * - the path is decoded once, joined under the root, and must still be under
 *   the root afterwards;
 * - the file's *real* location must be under the root too, so a link inside the
 *   folder cannot point out of it;
 * - nothing whose name starts with a dot is served, whether or not it exists;
 * - only `GET` and `HEAD`; only files, never folders; anything else is not
 *   found, with no hint as to why.
 *
 * It has no path to match state and must never be given one. A file server is
 * not a channel: see `match/projection.ts` for the only place the game speaks.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Worth compressing: text, in other words. */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.txt']);

/** Below this a file is not worth the header that says it was compressed. */
const SMALLEST_WORTH_COMPRESSING = 1_024;

/**
 * What the page is allowed to do.
 *
 * Nothing in this game is loaded from anywhere else — no fonts, no images, no
 * scripts — so the page is told it may not, and a bug that tried would be
 * stopped by the browser instead of by luck. `data:` and `blob:` images are the
 * favicon and the grain on the front page; the socket may be on another host
 * when the client was built to point at one.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const compressWith = {
  br: (data: Buffer) =>
    promisify(brotliCompress)(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }),
  gzip: (data: Buffer) => promisify(gzip)(data, { level: 8 }),
} as const;
type Encoding = keyof typeof compressWith;

export type StaticHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

/**
 * Returns a handler that answers a request from `root` if it can.
 *
 * It resolves to `true` when it has answered and `false` when the request is
 * not its to answer — a file that is not there, a method it does not serve, a
 * path that tried something — so the caller says "not found" the same way for
 * all of them.
 */
export function createStaticHandler(root: string): StaticHandler {
  // Compressed once and kept: the files are fixed for as long as this runs.
  const compressed = new Map<string, Promise<Buffer>>();
  let realRoot: Promise<string> | null = null;

  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;

    const file = await locate(request.url ?? '/');
    if (!file) return false;

    const extension = extname(file.path).toLowerCase();
    const headers: Record<string, string> = {
      'content-type': TYPES[extension] ?? 'application/octet-stream',
      // A file is what its extension says it is, not what it happens to look like.
      'x-content-type-options': 'nosniff',
    };

    if (file.hashed) {
      // The name changes whenever the contents do, so it can be kept for ever.
      headers['cache-control'] = 'public, max-age=31536000, immutable';
    } else {
      // The page is what names the hashed files. Keep it, and a deploy is
      // invisible until the cache happens to let go.
      headers['cache-control'] = 'no-cache';
      headers['etag'] = `W/"${file.size.toString(16)}-${Math.round(file.modified).toString(16)}"`;
    }
    if (extension === '.html') {
      headers['content-security-policy'] = CONTENT_SECURITY_POLICY;
      headers['referrer-policy'] = 'no-referrer';
      headers['x-frame-options'] = 'DENY';
    }

    if (headers['etag'] && request.headers['if-none-match'] === headers['etag']) {
      response.writeHead(304, headers).end();
      return true;
    }

    const encoding = COMPRESSIBLE.has(extension) && file.size >= SMALLEST_WORTH_COMPRESSING ? accepted(request) : null;
    if (COMPRESSIBLE.has(extension)) headers['vary'] = 'Accept-Encoding';

    if (encoding) {
      const key = `${file.path}:${file.modified}:${encoding}`;
      let body = compressed.get(key);
      if (!body) {
        body = readFile(file.path).then(compressWith[encoding]);
        compressed.set(key, body);
        // A failed read is not kept: the next request tries again.
        body.catch(() => compressed.delete(key));
      }
      const bytes = await body;
      headers['content-encoding'] = encoding;
      headers['content-length'] = String(bytes.length);
      response.writeHead(200, headers);
      response.end(request.method === 'HEAD' ? undefined : bytes);
      return true;
    }

    headers['content-length'] = String(file.size);
    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return true;
    }
    await new Promise<void>((resolve) => {
      const stream = createReadStream(file.path);
      stream.on('error', () => {
        response.destroy();
        resolve();
      });
      stream.on('end', resolve);
      stream.pipe(response);
    });
    return true;
  };

  /** Turns a request's URL into a file under the root, or nothing. */
  async function locate(
    url: string,
  ): Promise<{ path: string; size: number; modified: number; hashed: boolean } | null> {
    // Everything after `?` is the page's business, not the file's.
    const question = url.indexOf('?');
    let pathname: string;
    try {
      // Decoded exactly once. Decoding twice is how `%252e` becomes a dot.
      pathname = decodeURIComponent(question < 0 ? url : url.slice(0, question));
    } catch {
      return null;
    }
    if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\')) return null;
    if (pathname === '/') pathname = '/index.html';

    const segments = pathname.split('/').slice(1);
    // No empty parts (`//`), no way up, and nothing hidden.
    if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return null;

    const candidate = join(root, ...segments);
    if (!candidate.startsWith(root + sep)) return null;

    try {
      const info = await stat(candidate);
      if (!info.isFile()) return null;
      // Where it really is, links followed. A link out of the folder is out.
      realRoot ??= realpath(root);
      const [actual, base] = await Promise.all([realpath(candidate), realRoot]);
      if (!actual.startsWith(base + sep)) return null;
      return { path: actual, size: info.size, modified: info.mtimeMs, hashed: segments[0] === 'assets' };
    } catch {
      return null;
    }
  }
}

/** The best encoding the client said it can read, of the two this can write. */
function accepted(request: IncomingMessage): Encoding | null {
  const header = String(request.headers['accept-encoding'] ?? '').toLowerCase();
  if (/\bbr\b/.test(header)) return 'br';
  if (/\bgzip\b/.test(header)) return 'gzip';
  return null;
}
