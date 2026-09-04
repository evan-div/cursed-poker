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

  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    const timer = setTimeout(() => {
      this.#handles.delete(id);
      fn();
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
