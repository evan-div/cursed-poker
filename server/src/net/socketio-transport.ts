import type { Server as SocketIoServer, Socket } from 'socket.io';
import { clientAddress } from './client-address.js';
import type { AckFn, Connection, InboundHandler, Transport, ServerMessageName, ServerPayload } from './transport.js';

/**
 * Socket.IO behind the `Transport` seam.
 *
 * The only file in the server that knows which library carries the bytes.
 * Note the direction of the primitives: this wraps *one socket at a time* and
 * exposes `send`, never a broadcast. Sending the same payload to everybody is
 * something the game layer would have to go out of its way to do, which is the
 * right default for a game built on hidden information.
 */
export class SocketIoTransport implements Transport {
  readonly #io: SocketIoServer;
  #handler: ((connection: Connection) => void) | null = null;

  /**
   * `trustedProxies` is how many reverse proxies stand in front of this server,
   * for working out whose address a connection really has. See
   * `client-address.ts`; zero, the default, believes only the socket.
   */
  constructor(io: SocketIoServer, options: { trustedProxies?: number } = {}) {
    this.#io = io;
    const trustedProxies = options.trustedProxies ?? 0;
    this.#io.on('connection', (socket) => {
      this.#handler?.(new SocketConnection(socket, trustedProxies));
    });
  }

  onConnection(handler: (connection: Connection) => void): void {
    this.#handler = handler;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#io.close(() => resolve()));
  }
}

class SocketConnection implements Connection {
  readonly #socket: Socket;
  readonly #address: string;

  constructor(socket: Socket, trustedProxies: number) {
    this.#socket = socket;
    // Worked out once, from the handshake: it is what the connection was when
    // it was made, and a rate limit keyed on something that could change
    // mid-connection would be a rate limit somebody could step round.
    this.#address = clientAddress(
      socket.handshake.headers['x-forwarded-for'],
      socket.handshake.address,
      trustedProxies,
    );
  }

  get id(): string {
    return this.#socket.id;
  }

  get remoteAddress(): string {
    return this.#address;
  }

  send<K extends ServerMessageName>(name: K, payload: ServerPayload<K>): void {
    this.#socket.emit(name, payload);
  }

  onMessage(handler: InboundHandler): void {
    this.#socket.onAny((name: string, ...args: unknown[]) => {
      // Socket.IO puts an acknowledgement callback last when the client supplies
      // one, so a message may arrive as (payload), (ack) or (payload, ack).
      let payload: unknown;
      let ack: AckFn | undefined;
      for (const arg of args) {
        if (typeof arg === 'function') ack = arg as AckFn;
        else payload = arg;
      }
      handler(name, payload, ack);
    });
  }

  onClose(handler: () => void): void {
    this.#socket.on('disconnect', handler);
  }

  close(): void {
    this.#socket.disconnect(true);
  }
}
