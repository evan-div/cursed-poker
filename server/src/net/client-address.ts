/**
 * Whose address a connection is counted against.
 *
 * Two things are throttled per address: opening lobbies, and guessing their
 * codes. On a machine reached directly, a connection's address is simply where
 * the socket came from. Behind a reverse proxy — which is every hosted
 * deployment there is — it is the proxy's, for everybody, and twelve join
 * attempts a minute becomes the budget for the whole world.
 *
 * The proxy says who it was really talking to in `X-Forwarded-For`. The catch
 * is that the header arrives with whatever the client put in it already there:
 * each proxy *appends* the address it received the connection from. So the
 * only entries worth believing are the ones added by proxies we run, which are
 * the last ones, and a client that sends its own header has it ignored rather
 * than obeyed.
 *
 * `trustedProxies` is how many of those there are. Zero — the default — means
 * the header is not read at all, because on a server reached directly it is
 * entirely the client's to write.
 */
export function clientAddress(
  forwardedFor: string | readonly string[] | undefined,
  socketAddress: string,
  trustedProxies: number,
): string {
  const direct = tidy(socketAddress) || 'unknown';
  if (trustedProxies <= 0 || forwardedFor === undefined) return direct;

  const header = typeof forwardedFor === 'string' ? forwardedFor : forwardedFor.join(',');
  const hops = header
    .split(',')
    .map((entry) => tidy(entry))
    .filter((entry) => entry.length > 0);

  // Counting back from the right: the last trusted proxy appended the address
  // of the one before it, and so on, until the entry the outermost one added —
  // which is the client. A header shorter than that was not written by the
  // proxies we were told about, so none of it is believed.
  const index = hops.length - trustedProxies;
  return index >= 0 ? hops[index]! : direct;
}

/** One spelling per address: an IPv4 peer on a dual-stack socket is still IPv4. */
function tidy(address: string): string {
  const trimmed = address.trim();
  return trimmed.toLowerCase().startsWith('::ffff:') && trimmed.includes('.') ? trimmed.slice(7) : trimmed;
}
