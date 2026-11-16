import { describe, expect, it } from 'vitest';
import { clientAddress } from './client-address.js';

/**
 * Whose address a connection is counted against.
 *
 * Lobby-code guessing is throttled per address. Get this wrong one way and
 * every player behind a proxy shares one budget; get it wrong the other way and
 * anybody can pick a fresh address for every guess by typing one into a header.
 */
describe('whose address a connection has', () => {
  it('is the socket address when no proxy is trusted, whatever the headers say', () => {
    expect(clientAddress('203.0.113.9', '10.0.0.1', 0)).toBe('10.0.0.1');
    expect(clientAddress('1.1.1.1, 2.2.2.2', '10.0.0.1', 0)).toBe('10.0.0.1');
  });

  it('is the address the one trusted proxy saw', () => {
    // A proxy appends the address it received the connection from, so with one
    // trusted hop the client is the last entry.
    expect(clientAddress('203.0.113.9', '10.0.0.1', 1)).toBe('203.0.113.9');
  });

  it('cannot be chosen by the client', () => {
    // Everything to the left of what the proxy appended came from the request
    // itself. A client that sends its own header gets it ignored.
    expect(clientAddress('6.6.6.6, 203.0.113.9', '10.0.0.1', 1)).toBe('203.0.113.9');
    expect(clientAddress('6.6.6.6, 7.7.7.7, 203.0.113.9', '10.0.0.1', 1)).toBe('203.0.113.9');
  });

  it('counts back through as many proxies as are trusted', () => {
    // A CDN in front of a platform proxy: two hops, client third from the right.
    expect(clientAddress('6.6.6.6, 203.0.113.9, 198.51.100.4', '10.0.0.1', 2)).toBe('203.0.113.9');
  });

  it('falls back to the socket address when the header is missing or too short', () => {
    expect(clientAddress(undefined, '10.0.0.1', 1)).toBe('10.0.0.1');
    expect(clientAddress('', '10.0.0.1', 1)).toBe('10.0.0.1');
    expect(clientAddress('203.0.113.9', '10.0.0.1', 2)).toBe('10.0.0.1');
    expect(clientAddress(' , ', '10.0.0.1', 1)).toBe('10.0.0.1');
  });

  it('reads a header that arrived more than once', () => {
    expect(clientAddress(['6.6.6.6', '203.0.113.9'], '10.0.0.1', 1)).toBe('203.0.113.9');
  });

  it('treats an IPv4 address the same however the socket spells it', () => {
    // Node reports IPv4 peers on a dual-stack socket as IPv6-mapped. The same
    // person must not get two budgets.
    expect(clientAddress(undefined, '::ffff:203.0.113.9', 0)).toBe('203.0.113.9');
    expect(clientAddress('::ffff:203.0.113.9', '10.0.0.1', 1)).toBe('203.0.113.9');
  });

  it('never returns nothing', () => {
    expect(clientAddress(undefined, '', 0)).toBe('unknown');
  });
});
