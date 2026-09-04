import type { Server as SocketIoServer, Socket } from 'socket.io';
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

  constructor(io: SocketIoServer) {
    this.#io = io;
    this.#io.on('connection', (socket) => {
      this.#handler?.(new SocketConnection(socket));
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

  constructor(socket: Socket) {
    this.#socket = socket;
  }

  get id(): string {
    return this.#socket.id;
  }

  get remoteAddress(): string {
    // Behind a reverse proxy this needs `trust proxy` handling before it can be
    // used for rate limiting in production.
    return this.#socket.handshake.address || 'unknown';
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
