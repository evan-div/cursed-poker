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
    attention.focus(1, ATTENTION_WEIGHT.turn, T0);

    expect(attention.step(0, 1 / 60, T0 + 10)).toBeGreaterThan(0);

    // And the other way, for a subject on the other side.
    const other = new AttentionDirector();
    other.focus(-1, ATTENTION_WEIGHT.turn, T0);
    expect(other.step(0, 1 / 60, T0 + 10)).toBeLessThan(0);
  });

  it('turns the head without ever lifting it', () => {
    // Every face at this table is at the same height, so a bias with a pitch
    // component pushes the same way every time it fires — and four players
    // acting in turn is four pushes. The view walked up off the felt until the
    // player was staring at everybody's chest. Yaw cancels; pitch accumulates.
    // So the bias does not touch pitch at all, and this is the test that says
    // so, because the failure took a screenshot from a real session to spot.
    const attention = new AttentionDirector();
    const seatsInTurn = [1.1, -0.9, 0.4, -1.2, 0.8];

    let yaw = 0;
    for (let round = 0; round < seatsInTurn.length; round++) {
      const target = seatsInTurn[round]!;
      for (let t = 0; t < 1_400; t += 16) {
        const now = T0 + round * 1_400 + t;
        attention.focus(target, ATTENTION_WEIGHT.turn, now);
        yaw += attention.step(yaw, 0.016, now);
      }
    }

    // The head has moved — it is doing its job — but it is still within the
    // spread of the seats rather than somewhere none of them are.
    expect(Math.abs(yaw)).toBeLessThan(1.2);
  });

  it('never closes the whole gap, however long it runs', () => {
    // The bug this replaces: the bias moved a fraction of the *remaining* gap
    // each frame, which converges on the target. A player sitting still for a
    // second ended up staring straight at whoever had acted, and while peeking
    // they could not even fight it. Run it long past the point where the old
    // version had arrived.
    const attention = new AttentionDirector({ maxClose: 0.62 });
    let yaw = 0;
    for (let t = 0; t < 10_000; t += 16) {
      attention.focus(1, ATTENTION_WEIGHT.reckoning, T0 + t, 1_400);
      yaw += attention.step(yaw, 0.016, T0 + t);
    }
    expect(yaw).toBeGreaterThan(0.2);
    expect(yaw).toBeLessThanOrEqual(0.62 + 1e-6);
  });

  it('nudges by a share of the angle, whatever the frame rate', () => {
    // A slow client must not get a *stronger* pull than a fast one just because
    // its frames are further apart. This one runs at three frames a second.
    const attention = new AttentionDirector({ maxClose: 0.62 });
    let yaw = 0;
    for (let t = 0; t < 10_000; t += 333) {
      attention.focus(1, ATTENTION_WEIGHT.reckoning, T0 + t, 1_400);
      yaw += attention.step(yaw, 0.333, T0 + t);
    }
    expect(yaw).toBeLessThanOrEqual(0.62 + 1e-6);
  });

  it('measures its reach from where the head actually was', () => {
    // Already halfway there: the pull may only close part of what is left, not
    // drag the head back out to a fixed fraction of some absolute angle.
    const attention = new AttentionDirector({ maxClose: 0.5 });
    let yaw = 0.8;
    for (let t = 0; t < 5_000; t += 16) {
      attention.focus(1, 1, T0 + t, 1_400);
      yaw += attention.step(yaw, 0.016, T0 + t);
    }
    expect(yaw).toBeGreaterThan(0.8);
    expect(yaw).toBeLessThanOrEqual(0.9 + 1e-6); // 0.8 + half of the remaining 0.2
  });

  it('turns a head no faster than a neck could', () => {
    const attention = new AttentionDirector({ maxRadiansPerSecond: 1 });
    attention.focus(3, 1, T0);
    // A huge angle, a whole second of it: still capped.
    expect(attention.step(-3, 1, T0 + 1)).toBeLessThanOrEqual(1);
  });

  it('fades out rather than stopping dead', () => {
    const attention = new AttentionDirector();
    attention.focus(1, 1, T0, 1_000);
    const early = attention.step(0, 0.016, T0 + 50);
    const late = attention.step(0, 0.016, T0 + 900);
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(early);
  });

  it('expires, and lets go', () => {
    const attention = new AttentionDirector();
    attention.focus(1, 1, T0, 1_000);
    expect(attention.step(0, 0.016, T0 + 1_001)).toBe(0);
    expect(attention.pull).toBeNull();
  });

  it('does not let a smaller event elbow aside a larger one', () => {
    const attention = new AttentionDirector();
    attention.focus(1.2, ATTENTION_WEIGHT.allIn, T0);
    attention.focus(-0.4, ATTENTION_WEIGHT.turn, T0 + 100);
    expect(attention.pull!.yaw).toBe(1.2);

    // But a bigger one, or one after the first has expired, does.
    attention.focus(-0.4, ATTENTION_WEIGHT.reckoning, T0 + 200);
    expect(attention.pull!.yaw).toBe(-0.4);
  });
});

describe('the player overruling it', () => {
  it('lets go completely the moment somebody looks for themselves', () => {
    const attention = new AttentionDirector();
    attention.focus(1, 1, T0);
    attention.interrupt(40, T0 + 10);

    expect(attention.pull).toBeNull();
    expect(attention.step(0, 0.016, T0 + 11)).toBe(0);
  });

  it('stays out of the way for long enough to mean it', () => {
    const attention = new AttentionDirector({ overrideMs: 2_000 });
    attention.interrupt(40, T0);

    // Something important happens while the player is deliberately elsewhere.
    attention.focus(1, ATTENTION_WEIGHT.reckoning, T0 + 500);
    expect(attention.step(0, 0.016, T0 + 500)).toBe(0);
    expect(attention.isSuppressed(T0 + 1_999)).toBe(true);

    // And then hands control back.
    expect(attention.isSuppressed(T0 + 2_001)).toBe(false);
    attention.focus(1, ATTENTION_WEIGHT.turn, T0 + 2_001);
    expect(attention.step(0, 0.016, T0 + 2_010)).toBeGreaterThan(0);
  });

  it('ignores movement too small to be a decision', () => {
    const attention = new AttentionDirector({ overridePixels: 6 });
    attention.focus(1, 1, T0);
    attention.interrupt(2, T0 + 10); // pointer noise, a resting palm
    expect(attention.pull).not.toBeNull();
    expect(attention.step(0, 0.016, T0 + 11)).toBeGreaterThan(0);
  });

  it('can be cleared without being suppressed', () => {
    const attention = new AttentionDirector();
    attention.focus(1, 1, T0);
    attention.clear();
    expect(attention.pull).toBeNull();
    expect(attention.isSuppressed(T0)).toBe(false);
  });

  it('does nothing on a zero-length frame', () => {
    const attention = new AttentionDirector();
    attention.focus(1, 1, T0);
    expect(attention.step(0, 0, T0)).toBe(0);
  });
});
