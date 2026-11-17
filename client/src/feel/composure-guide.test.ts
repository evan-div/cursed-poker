import { describe, expect, it } from 'vitest';
import type { ComposureChallengeView } from '@cursed/shared';
import { ComposureGuide, HOLD_GUIDE } from './composure-guide.js';

/**
 * The guide a player follows while steadying themselves.
 *
 * It judges nothing — the server does — but it has to point at exactly what
 * the server scores, or following it faithfully would fail.
 */

const breath: ComposureChallengeView = {
  id: 'c1',
  kind: 'BREATH',
  spec: { gapsMs: [1_000, 1_200, 900] },
  issuedAt: 0,
  expiresAt: 10_000,
};

const hold: ComposureChallengeView = {
  id: 'c2',
  kind: 'HOLD',
  spec: { holdMs: 3_000 },
  issuedAt: 0,
  expiresAt: 10_000,
};

describe('the breath guide', () => {
  it('waits for the first tap, then counts toward the next', () => {
    const guide = new ComposureGuide(breath);
    expect(guide.state(500)).toEqual({ kind: 'BREATH', stage: 'WAITING' });

    guide.press('DOWN', 1_000);
    expect(guide.state(1_500)).toMatchObject({ stage: 'BREATHING', taps: 1, of: 4, phase: 0.5 });
    expect(guide.state(2_000)).toMatchObject({ phase: 1 });
  });

  it('measures each beat from the tap the player actually made', () => {
    // The server scores the gap between two taps. A player who came in late
    // on one beat is shown the next gap from where they really are.
    const guide = new ComposureGuide(breath);
    guide.press('DOWN', 0);
    guide.press('DOWN', 1_300); // 300ms late
    expect(guide.state(1_300 + 600)).toMatchObject({ taps: 2, phase: 0.5 });
  });

  it('is done after the last beat, and ignores key releases', () => {
    const guide = new ComposureGuide(breath);
    for (const at of [0, 1_000, 2_200, 3_100]) {
      guide.press('DOWN', at);
      guide.press('UP', at + 80);
    }
    expect(guide.state(3_200)).toEqual({ kind: 'BREATH', stage: 'DONE' });
  });
});

describe('the hold guide', () => {
  it('fills while held, and fades out before the end', () => {
    const guide = new ComposureGuide(hold);
    expect(guide.state(0)).toEqual({ kind: 'HOLD', stage: 'WAITING' });

    guide.press('DOWN', 1_000);
    const early = guide.state(1_000 + 3_000 * 0.2);
    expect(early).toMatchObject({ stage: 'HOLDING', visible: 1 });
    // The last of it has to be counted, not watched.
    const gone = guide.state(1_000 + 3_000 * HOLD_GUIDE.goneAt);
    expect(gone).toMatchObject({ visible: 0 });
    expect(guide.state(1_000 + 3_000)).toMatchObject({ fill: 1, visible: 0 });
  });

  it('ignores a release from before it was pressed, and stops on the real one', () => {
    const guide = new ComposureGuide(hold);
    guide.press('UP', 10);
    expect(guide.state(20)).toMatchObject({ stage: 'WAITING' });
    guide.press('DOWN', 100);
    guide.press('UP', 3_100);
    expect(guide.state(3_200)).toEqual({ kind: 'HOLD', stage: 'RELEASED' });
  });
});

it('admits it does not know how to draw a kind it has never seen', () => {
  const guide = new ComposureGuide({ ...breath, kind: 'KNOCK', spec: {} });
  expect(guide.state(0)).toEqual({ kind: 'KNOCK', stage: 'UNKNOWN' });
});
