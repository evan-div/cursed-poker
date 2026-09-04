import type { ServerMessages } from '@cursed/shared';

/**
 * The transport seam.
 *
 * Socket.IO is the current implementation (see docs/ARCHITECTURE for why), but
 * nothing above this interface knows that. If the high-frequency tell channel
 * later justifies WebTransport or a WebRTC datachannel, that is a second
 * implementation alongside this one, not a rewrite of the game.
 */

export type ServerMessageName = keyof ServerMessages;
export type ServerPayload<K extends ServerMessageName> = Parameters<ServerMessages[K]>[0];

/** A reply to a request-shaped message. */
export type AckFn = (response: unknown) => void;

export type InboundHandler = (name: string, payload: unknown, ack?: AckFn) => void;

export interface Connection {
  readonly id: string;
  /** For per-address rate limiting. May be a placeholder in tests. */
  readonly remoteAddress: string;
  send<K extends ServerMessageName>(name: K, payload: ServerPayload<K>): void;
  onMessage(handler: InboundHandler): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface Transport {
  onConnection(handler: (connection: Connection) => void): void;
  close(): Promise<void>;
}
