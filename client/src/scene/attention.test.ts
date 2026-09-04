import { describe, expect, it } from 'vitest';
import { ATTENTION_WEIGHT, AttentionDirector } from './attention.js';

/**
 * Attention, and the right to ignore it.
 *
 * The interesting assertions here are the negative ones. A camera that pulls
 * toward the acting player is easy; a camera that *stops* the instant a player
 * looks somewhere deliberately, and stays stopped, is the thing that keeps
 * "watching the wrong person on purpose" a playable move.
 */

const T0 = 500_000;

describe('the pull', () => {
  it('moves a head toward whatever wants attention', () => {
    const attention = new AttentionDirector();
    attention.focus(1, -0.2, ATTENTION_WEIGHT.turn, T0);

    const step = attention.step(0, 0, 1 / 60, T0 + 10);
    expect(step.yaw).toBeGreaterThan(0);
    expect(step.pitch).toBeLessThan(0);
  });

  it('never closes the whole gap, however long it runs', () => {
    const attention = new AttentionDirector();
    let yaw = 0;
    for (let t = 0; t < 1_300; t += 16) {
      attention.focus(1, 0, ATTENTION_WEIGHT.reckoning, T0 + t, 1_400);
      yaw += attention.step(yaw, 0, 0.016, T0 + t).yaw;
    }
    expect(yaw).toBeGreaterThan(0.2);
    expect(yaw).toBeLessThan(1);
  });

  it('turns a head no faster than a neck could', () => {
    const attention = new AttentionDirector({ maxRadiansPerSecond: 1 });
    attention.focus(3, 0, 1, T0);
    // A huge angle, a whole second of it: still capped.
    expect(attention.step(-3, 0, 1, T0 + 1).yaw).toBeLessThanOrEqual(1);
  });

  it('fades out rather than stopping dead', () => {
    const attention = new AttentionDirector();
    attention.focus(1, 0, 1, T0, 1_000);
    const early = attention.step(0, 0, 0.016, T0 + 50).yaw;
    const late = attention.step(0, 0, 0.016, T0 + 900).yaw;
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(early);
  });

  it('expires, and lets go', () => {
    const attention = new AttentionDirector();
    attention.focus(1, 0, 1, T0, 1_000);
    expect(attention.step(0, 0, 0.016, T0 + 1_001)).toEqual({ yaw: 0, pitch: 0 });
    expect(attention.pull).toBeNull();
  });

  it('does not let a smaller event elbow aside a larger one', () => {
    const attention = new AttentionDirector();
    attention.focus(1.2, 0, ATTENTION_WEIGHT.allIn, T0);
    attention.focus(-0.4, 0, ATTENTION_WEIGHT.turn, T0 + 100);
    expect(attention.pull!.yaw).toBe(1.2);

    // But a bigger one, or one after the first has expired, does.
    attention.focus(-0.4, 0, ATTENTION_WEIGHT.reckoning, T0 + 200);
    expect(attention.pull!.yaw).toBe(-0.4);
  });
});

describe('the player overruling it', () => {
  it('lets go completely the moment somebody looks for themselves', () => {
    const attention = new AttentionDirector();
    attention.focus(1, 0, 1, T0);
    attention.interrupt(40, T0 + 10);

    expect(attention.pull).toBeNull();
    expect(attention.step(0, 0, 0.016, T0 + 11)).toEqual({ yaw: 0, pitch: 0 });
  });

  it('stays out of the way for long enough to mean it', () => {
    const attention = new AttentionDirector({ overrideMs: 2_000 });
    attention.interrupt(40, T0);

    // Something important happens while the player is deliberately elsewhere.
    attention.focus(1, 0, ATTENTION_WEIGHT.reckoning, T0 + 500);
    expect(attention.step(0, 0, 0.016, T0 + 500)).toEqual({ yaw: 0, pitch: 0 });
    expect(attention.isSuppressed(T0 + 1_999)).toBe(true);

    // And then hands control back.
    expect(attention.isSuppressed(T0 + 2_001)).toBe(false);
    attention.focus(1, 0, ATTENTION_WEIGHT.turn, T0 + 2_001);
    expect(attention.step(0, 0, 0.016, T0 + 2_010).yaw).toBeGreaterThan(0);
  });

  it('ignores movement too small to be a decision', () => {
    const attention = new AttentionDirector({ overridePixels: 6 });
    attention.focus(1, 0, 1, T0);
    attention.interrupt(2, T0 + 10); // pointer noise, a resting palm
    expect(attention.pull).not.toBeNull();
    expect(attention.step(0, 0, 0.016, T0 + 11).yaw).toBeGreaterThan(0);
  });

  it('can be cleared without being suppressed', () => {
    const attention = new AttentionDirector();
    attention.focus(1, 0, 1, T0);
    attention.clear();
    expect(attention.pull).toBeNull();
    expect(attention.isSuppressed(T0)).toBe(false);
  });

  it('does nothing on a zero-length frame', () => {
    const attention = new AttentionDirector();
    attention.focus(1, 0, 1, T0);
    expect(attention.step(0, 0, 0, T0)).toEqual({ yaw: 0, pitch: 0 });
  });
});
