/**
 * Time, injected.
 *
 * A 60-90 minute match is built out of timeouts: action clocks, blind levels,
 * showdown display, reconnect grace. None of that is testable against the real
 * clock, so everything goes through this interface and tests drive a manual one.
 */

export type TimerHandle = { readonly id: number };

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null): void;
}

export class SystemClock implements Clock {
  #handles = new Map<number, NodeJS.Timeout>();
  #nextId = 1;
  readonly #onError: (error: unknown) => void;

  /**
   * `onError` hears about a timer callback that threw.
   *
   * Every match in the process runs on timers from here, and an exception
   * escaping one is an uncaught exception: Node exits, and every other table
   * in memory goes with it. A match whose own invariant has failed is already
   * lost; the five beside it are not, so the failure is reported and contained
   * rather than allowed to take the building down.
   */
  constructor(onError?: (error: unknown) => void) {
    this.#onError =
      onError ?? ((error) => console.error('[cursed-poker] a match timer threw:', error));
  }

  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    const timer = setTimeout(() => {
      this.#handles.delete(id);
      try {
        fn();
      } catch (error) {
        this.#onError(error);
      }
    }, ms);
    // Never hold the process open for a game timer.
    timer.unref?.();
    this.#handles.set(id, timer);
    return { id };
  }

  clearTimeout(handle: TimerHandle | null): void {
    if (!handle) return;
    const timer = this.#handles.get(handle.id);
    if (timer) {
      clearTimeout(timer);
      this.#handles.delete(handle.id);
    }
  }
}

/** Deterministic clock for tests. Nothing fires until `advance` is called. */
export class ManualClock implements Clock {
  #now: number;
  #nextId = 1;
  #pending = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#pending.set(id, { at: this.#now + Math.max(0, ms), fn });
    return { id };
  }

  clearTimeout(handle: TimerHandle | null): void {
    if (handle) this.#pending.delete(handle.id);
  }

  /** Moves time forward, firing timers in order, including ones they schedule. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const next = [...this.#pending.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.#pending.delete(id);
      this.#now = Math.max(this.#now, timer.at);
      timer.fn();
    }
    this.#now = target;
  }

  /** Advances until nothing is scheduled, or the budget runs out. */
  runUntilIdle(maxMs = 60 * 60 * 1000, stepMs = 250): void {
    let spent = 0;
    while (this.#pending.size > 0 && spent < maxMs) {
      this.advance(stepMs);
      spent += stepMs;
    }
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}
