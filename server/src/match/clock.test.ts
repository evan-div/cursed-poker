import { describe, expect, it, vi } from 'vitest';
import { SystemClock } from './clock.js';

describe('the system clock', () => {
  it('contains a timer that throws instead of letting it end the process', () => {
    vi.useFakeTimers();
    try {
      const seen: unknown[] = [];
      const clock = new SystemClock((error) => seen.push(error));
      let later = false;

      clock.setTimeout(() => {
        throw new Error('chip conservation violated');
      }, 10);
      clock.setTimeout(() => {
        later = true;
      }, 20);

      // An exception escaping a timer is an uncaught one: every table in the
      // process would go down for one table's bug.
      expect(() => vi.advanceTimersByTime(30)).not.toThrow();
      expect(seen).toHaveLength(1);
      expect(String(seen[0])).toMatch(/chip conservation/);
      expect(later).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire a timer that was cleared', () => {
    vi.useFakeTimers();
    try {
      const clock = new SystemClock();
      let fired = false;
      const handle = clock.setTimeout(() => {
        fired = true;
      }, 10);
      clock.clearTimeout(handle);
      vi.advanceTimersByTime(50);
      expect(fired).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
