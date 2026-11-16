import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticHandler } from './static.js';

/**
 * Serving the built client.
 *
 * This is the one part of the server that reads a path somebody else chose off
 * the disk, so the test that matters is the one that tries to walk out of the
 * folder. Run against a real HTTP server, because the ways out are all in how a
 * request line is parsed.
 */

const SECRET = 'the-session-secret-or-anything-else-on-this-disk';
const PAGE = '<!doctype html><title>Cursed Poker</title>';
const SCRIPT = `console.log(${JSON.stringify('x'.repeat(4_000))});`;

let scratch: string;
let server: Server;
let base: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'cursed-static-'));
  const root = join(scratch, 'dist');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), PAGE);
  await writeFile(join(root, 'assets', 'index-abc123.js'), SCRIPT);
  await writeFile(join(root, 'assets', 'index-abc123.css'), 'body{margin:0}');
  await writeFile(join(root, '.env'), SECRET);
  // Outside the folder being served: what an escape would be after.
  await writeFile(join(scratch, 'secret.txt'), SECRET);
  await symlink(join(scratch, 'secret.txt'), join(root, 'assets', 'link.txt'));

  const serve = createStaticHandler(root);
  server = createServer((req, res) => {
    void serve(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end('nothing here');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
});

/**
 * A request with the path sent exactly as written. `fetch` tidies `..` out of
 * a URL before sending it, which is the opposite of what an attacker does.
 */
async function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const { request } = await import('node:http');
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serving the client', () => {
  it('serves the page at the root, and tells browsers not to keep it', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    // The page names the hashed files. Cache it and a deploy is invisible.
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('ignores a query string, so ?quality=low is still the page', async () => {
    const response = await fetch(`${base}/?quality=low`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE);
  });

  it('serves hashed assets for good', async () => {
    const response = await fetch(`${base}/assets/index-abc123.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
    expect(response.headers.get('cache-control')).toMatch(/immutable/);
    expect(response.headers.get('cache-control')).toMatch(/max-age=31536000/);
    expect(await response.text()).toBe(SCRIPT);
  });

  it('says what each file is, and that it is not to be guessed at', async () => {
    const css = await fetch(`${base}/assets/index-abc123.css`);
    expect(css.headers.get('content-type')).toMatch(/^text\/css/);
    expect(css.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('locks the page down', async () => {
    const response = await fetch(`${base}/`);
    const policy = response.headers.get('content-security-policy') ?? '';
    // Nothing is loaded from anywhere else, so nothing is allowed to be.
    expect(policy).toMatch(/default-src 'self'/);
    expect(policy).toMatch(/script-src 'self'/);
    expect(policy).not.toMatch(/unsafe-eval/);
    expect(policy).toMatch(/frame-ancestors 'none'/);
  });

  it('compresses what compresses, when asked, and gives back the same bytes', async () => {
    const gz = await raw('/assets/index-abc123.js', { 'accept-encoding': 'gzip' });
    expect(gz.status).toBe(200);
    const response = await fetch(`${base}/assets/index-abc123.js`, { headers: { 'accept-encoding': 'gzip' } });
    expect(response.headers.get('vary')).toMatch(/accept-encoding/i);
    expect(await response.text()).toBe(SCRIPT);

    // And really smaller on the wire, not just labelled.
    const { request } = await import('node:http');
    const url = new URL(base);
    const wire = await new Promise<Buffer>((resolve, reject) => {
      const req = request(
        { host: url.hostname, port: url.port, path: '/assets/index-abc123.js', headers: { 'accept-encoding': 'gzip' } },
        (res) => {
          expect(res.headers['content-encoding']).toBe('gzip');
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(wire.length).toBeLessThan(SCRIPT.length / 4);
    expect(gunzipSync(wire).toString('utf8')).toBe(SCRIPT);
  });

  it('answers a conditional request without sending the page again', async () => {
    const first = await fetch(`${base}/`);
    const tag = first.headers.get('etag');
    expect(tag).toBeTruthy();
    const second = await fetch(`${base}/`, { headers: { 'if-none-match': tag! } });
    expect(second.status).toBe(304);
  });

  it('answers HEAD with the headers and no body', async () => {
    const response = await fetch(`${base}/assets/index-abc123.js`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('leaves everything that is not a read to somebody else', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`${base}/`, { method });
      expect(response.status).toBe(404);
    }
  });

  it('does not find what is not there', async () => {
    for (const path of ['/nope.js', '/assets/', '/assets', '/assets/missing.css', '/index.html/extra']) {
      const response = await raw(path);
      expect(response.status, path).toBe(404);
    }
  });

  it('cannot be walked out of', async () => {
    // Every way of writing "the folder above" that a request line allows.
    for (const path of [
      '/../secret.txt',
      '/../../secret.txt',
      '/assets/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/%2E%2E/secret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/..%5csecret.txt',
      '/assets/..\\..\\secret.txt',
      '/%252e%252e/secret.txt',
      '//secret.txt',
      '/assets/%00/../../secret.txt',
      '/....//secret.txt',
    ]) {
      const response = await raw(path);
      expect(response.body, `${path} leaked`).not.toContain(SECRET);
      expect(response.status, path).toBe(404);
    }
  });

  it('does not follow a link out of the folder', async () => {
    const response = await raw('/assets/link.txt');
    expect(response.body).not.toContain(SECRET);
    expect(response.status).toBe(404);
  });

  it('does not serve hidden files, even ones that are really there', async () => {
    const response = await raw('/.env');
    expect(response.body).not.toContain(SECRET);
    expect(response.status).toBe(404);
  });

  it('survives a path that is not valid at all', async () => {
    for (const path of ['/%', '/%zz', '/%c0%ae%c0%ae/secret.txt']) {
      const response = await raw(path);
      expect(response.status, path).toBe(404);
      expect(response.body).not.toContain(SECRET);
    }
  });
});
