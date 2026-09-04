import { io, type Socket } from 'socket.io-client';
import type { ClientMessageName, ClientView, MatchEvent, SessionGrant } from '@cursed/shared';

/**
 * The client half of the transport seam.
 *
 * It holds no game state and makes no rules — it sends intents and receives
 * views. Every decision it appears to make (what is legal, whose turn it is) is
 * really the server's, arriving inside a `ClientView`.
 */

export type Ack<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3001';
const TOKEN_KEY = 'cursed-poker.session';

export class GameConnection {
  readonly socket: Socket;
  onView: (view: ClientView) => void = () => {};
  onEvents: (events: MatchEvent[]) => void = () => {};
  onError: (error: { code: string; message: string }) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};

  constructor() {
    this.socket = io(SERVER_URL, { transports: ['websocket'] });
    this.socket.on('view', (view: ClientView) => this.onView(view));
    this.socket.on('events', (events: MatchEvent[]) => this.onEvents(events));
    this.socket.on('error', (error: { code: string; message: string }) => this.onError(error));
    this.socket.on('connect', () => {
      this.onStatus(true);
      void this.resumeIfPossible();
    });
    this.socket.on('disconnect', () => this.onStatus(false));
  }

  send<T>(name: ClientMessageName, payload: unknown): Promise<Ack<T>> {
    return new Promise((resolve) => {
      this.socket.emit(name, payload, (response: Ack<T>) => resolve(response));
    });
  }

  /** Reconnecting is automatic: the seat is held, and so are the cards. */
  async resumeIfPossible(): Promise<void> {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    const response = await this.send<SessionGrant>('lobby:resume', { token });
    if (!response.ok) localStorage.removeItem(TOKEN_KEY);
  }

  rememberSession(grant: SessionGrant): void {
    localStorage.setItem(TOKEN_KEY, grant.token);
  }

  forgetSession(): void {
    localStorage.removeItem(TOKEN_KEY);
  }
}
