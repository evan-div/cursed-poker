import { GAZE_AWAY, PRESENCE, gazeEquals, quantisePeek, type GazeTarget } from '@cursed/shared';

/**
 * Reporting your own body to the table.
 *
 * The client does not decide what other players see of it; it says what it is
 * doing and the server decides. This is the thing that makes tells work at all:
 * without it, gaze and card-peeking would be local animation that only the
 * player performing them could see, and "did they notice?" would have no
 * possible answer.
 *
 * Two consequences worth being explicit about.
 *
 * **Not reporting is not an option.** A client that stops sending is replicated
 * as *still*, and stillness is one of the loudest tells there is. The silence
 * this class protects against is the accidental kind — a dropped frame, a
 * throttle — not a deliberate one.
 *
 * **Reports are cheap and lossy.** Fifteen a second, volatile, no ack. A
 * dropped one is corrected 66ms later by the next.
 */

export interface BodyReport {
  gaze: GazeTarget;
  peek: number;
  handlingChips: boolean;
}

export interface PresenceReporterOptions {
  send: (report: BodyReport) => void;
  /** Reports per second. */
  hz?: number;
  /** Send at least this often even when nothing has changed. */
  heartbeatMs?: number;
}

export class PresenceReporter {
  #send: (report: BodyReport) => void;
  #intervalMs: number;
  #heartbeatMs: number;

  #current: BodyReport = { gaze: GAZE_AWAY, peek: 0, handlingChips: false };
  #lastSent: BodyReport | null = null;
  /**
   * Negative infinity means "due now".
   *
   * `performance.now()` starts near zero, so a plain 0 here would silently hold
   * the very first report back by an interval — and the first report is the one
   * that tells the table somebody has sat down.
   */
  #lastSentAt = Number.NEGATIVE_INFINITY;
  #enabled = false;

  constructor(options: PresenceReporterOptions) {
    this.#send = options.send;
    this.#intervalMs = 1000 / (options.hz ?? PRESENCE.clientHz);
    this.#heartbeatMs = options.heartbeatMs ?? PRESENCE.heartbeatMs;
  }

  /** Off in the lobby, on at the table. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    this.#lastSent = null;
    this.#lastSentAt = Number.NEGATIVE_INFINITY;
  }

  setGaze(target: GazeTarget): void {
    this.#current.gaze = target;
  }

  setPeek(exposure: number): void {
    this.#current.peek = exposure;
  }

  setHandlingChips(handling: boolean): void {
    this.#current.handlingChips = handling;
  }

  /**
   * Sends, if it is time to.
   *
   * Rate-limited and change-gated, with a heartbeat underneath so that a player
   * who has not moved is still positively reported as not moving.
   */
  update(now: number): void {
    if (!this.#enabled) return;
    if (now - this.#lastSentAt < this.#intervalMs) return;

    const stale = now - this.#lastSentAt >= this.#heartbeatMs;
    if (!stale && !this.#hasChanged()) return;

    // Quantised before sending, not after: there is no reason to put a
    // resolution on the wire that the server would only round away.
    const report: BodyReport = {
      gaze: this.#current.gaze,
      peek: quantisePeek(this.#current.peek),
      handlingChips: this.#current.handlingChips,
    };

    this.#send(report);
    this.#lastSent = report;
    this.#lastSentAt = now;
  }

  #hasChanged(): boolean {
    const last = this.#lastSent;
    if (!last) return true;
    return (
      !gazeEquals(last.gaze, this.#current.gaze) ||
      quantisePeek(last.peek) !== quantisePeek(this.#current.peek) ||
      last.handlingChips !== this.#current.handlingChips
    );
  }
}
