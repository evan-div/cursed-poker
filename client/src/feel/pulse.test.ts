import { describe, expect, it } from 'vitest';
import { STRESS, heartRateFor, tellCurves, tellsFor } from '@cursed/shared';
import { FEEL, Pulse, heartEnvelope, type FeltSound } from './pulse.js';

/**
 * What being frightened feels like, from the inside.
 *
 * None of this can be watched under a test, so it is pinned as numbers: whether
 * the heart beats at the rate the server said, whether a calm player feels
 * nothing at all, and whether the camera's shake stays something a person could
 * sit through.
 */

const FRAME = 1 / 60;

function settle(pulse: Pulse, seconds: number): FeltSound[] {
  const sounds: FeltSound[] = [];
  for (let t = 0; t < seconds; t += FRAME) sounds.push(...pulse.update(FRAME));
  return sounds;
}

function at(stress: number, options: { reducedMotion?: boolean } = {}): Pulse {
  const pulse = new Pulse({ seed: 7, ...options });
  pulse.setStress({ stress, heartRate: heartRateFor(stress) }, 1);
  settle(pulse, 5);
  return pulse;
}

describe('calm', () => {
  it('feels like nothing at all', () => {
    const pulse = at(0);
    const sounds = settle(pulse, 10);
    expect(sounds.filter((s) => s.kind === 'HEARTBEAT')).toEqual([]);
    expect(pulse.felt.tunnel).toBe(0);
    expect(pulse.felt.unsteadiness).toBe(0);
    // Breathing never quite stops — but at rest it is a fraction of a degree.
    const { yaw, pitch, roll } = pulse.felt.shake;
    expect(Math.abs(yaw)).toBe(0);
    expect(Math.abs(roll)).toBe(0);
    expect(Math.abs(pitch)).toBeLessThan(FEEL.breathRadians.calm + 1e-9);
  });

  it('starts calm before the server has said anything', () => {
    const pulse = new Pulse({ seed: 1 });
    pulse.update(FRAME);
    expect(pulse.felt.heartRate).toBeCloseTo(STRESS.restingBpm, 6);
  });
});

describe('the heart', () => {
  it('beats at the rate the server gave', () => {
    const pulse = at(0.7);
    const beats = settle(pulse, 20).filter((s) => s.kind === 'HEARTBEAT').length;
    const expected = (heartRateFor(0.7) / 60) * 20;
    expect(Math.abs(beats - expected)).toBeLessThanOrEqual(1);
  });

  it('gets louder as it gets faster', () => {
    const gain = (stress: number) => {
      const beat = settle(at(stress), 4).find((s) => s.kind === 'HEARTBEAT');
      return beat?.kind === 'HEARTBEAT' ? beat.gain : 0;
    };
    expect(gain(0.5)).toBeGreaterThan(0);
    expect(gain(0.95)).toBeGreaterThan(gain(0.5));
    expect(gain(1)).toBeLessThanOrEqual(FEEL.maxBeatGain);
  });

  it('keeps lub and dub inside one beat, however fast it goes', () => {
    for (const stress of [0.4, 0.8, 1]) {
      const beat = settle(at(stress), 4).find((s) => s.kind === 'HEARTBEAT');
      expect(beat?.kind).toBe('HEARTBEAT');
      if (beat?.kind !== 'HEARTBEAT') continue;
      expect(beat.gap).toBeLessThan(60 / heartRateFor(stress));
    }
  });

  it('has a two-part envelope', () => {
    const period = 0.6;
    expect(heartEnvelope(0, period)).toBeCloseTo(1, 6);
    const trough = heartEnvelope(0.29, period);
    const dub = heartEnvelope(FEEL.dubFraction, period);
    expect(dub).toBeGreaterThan(trough);
    expect(heartEnvelope(0.95, period)).toBeLessThan(0.01);
  });
});

describe('following the server', () => {
  it('eases toward a new reading rather than jumping', () => {
    const pulse = at(0);
    pulse.setStress({ stress: 1, heartRate: STRESS.maxBpm }, 2);
    pulse.update(FRAME);
    expect(pulse.felt.stress).toBeGreaterThan(0);
    expect(pulse.felt.stress).toBeLessThan(0.1);
    settle(pulse, 4);
    expect(pulse.felt.stress).toBeGreaterThan(0.98);
  });

  it('ignores a reading older than one it already has', () => {
    // The same heart arrives on two channels — the view and the private tick —
    // and they do not promise to arrive in order.
    const pulse = new Pulse({ seed: 3 });
    pulse.setStress({ stress: 0.9, heartRate: heartRateFor(0.9) }, 2_000);
    pulse.setStress({ stress: 0.1, heartRate: heartRateFor(0.1) }, 1_000);
    settle(pulse, 5);
    expect(pulse.felt.stress).toBeGreaterThan(0.85);
  });

  it('can be forced for a screenshot and handed back', () => {
    const pulse = at(0.1);
    pulse.force(1);
    settle(pulse, 5);
    expect(pulse.felt.stress).toBeGreaterThan(0.98);
    pulse.force(null);
    settle(pulse, 5);
    expect(pulse.felt.stress).toBeLessThan(0.12);
  });
});

describe('what it does to the view', () => {
  it('shakes more the worse it gets, and stays within reason', () => {
    const peak = (stress: number) => {
      const pulse = at(stress);
      let worst = 0;
      for (let i = 0; i < 600; i++) {
        pulse.update(FRAME);
        const { yaw, pitch, roll } = pulse.felt.shake;
        worst = Math.max(worst, Math.abs(yaw), Math.abs(pitch), Math.abs(roll));
      }
      return worst;
    };
    expect(peak(0.6)).toBeGreaterThan(peak(0.2));
    expect(peak(1)).toBeGreaterThan(peak(0.6));
    // Well under a degree and a half, even at full panic.
    expect(peak(1)).toBeLessThan(0.025);
  });

  it('closes the edges in, but never the middle', () => {
    expect(at(0.3).felt.tunnel).toBe(0);
    expect(at(0.7).felt.tunnel).toBeGreaterThan(0);
    const worst = at(1);
    let most = 0;
    for (let i = 0; i < 300; i++) {
      worst.update(FRAME);
      most = Math.max(most, worst.felt.tunnel);
    }
    expect(most).toBeLessThanOrEqual(FEEL.maxTunnel);
  });

  it('holds the camera still for a player who asked for less motion', () => {
    const pulse = at(1, { reducedMotion: true });
    for (let i = 0; i < 120; i++) {
      pulse.update(FRAME);
      expect(pulse.felt.shake).toEqual({ yaw: 0, pitch: 0, roll: 0 });
    }
    // They still get told: the edges still close and the heart is still heard.
    expect(pulse.felt.tunnel).toBeGreaterThan(0.5);
    expect(settle(pulse, 3).some((s) => s.kind === 'HEARTBEAT')).toBe(true);
  });

  it('shakes your hands exactly as hard as the table sees them shake', () => {
    // One curve, two resolutions: if they ever disagreed, a player could look
    // calm to themselves and shake on everybody else's screen.
    for (const stress of [0, 0.3, 0.5, 0.8, 1]) {
      const felt = at(stress).felt;
      expect(felt.unsteadiness).toBeCloseTo(tellCurves(stress).tremor, 2);
      expect(Math.abs(felt.unsteadiness - tellsFor(stress).tremor)).toBeLessThanOrEqual(
        0.5 / STRESS.tellSteps + 0.01,
      );
    }
  });

  it('breathes audibly only when it is bad', () => {
    expect(settle(at(0.2), 20).some((s) => s.kind === 'BREATH')).toBe(false);
    expect(settle(at(0.9), 20).some((s) => s.kind === 'BREATH')).toBe(true);
  });
});
