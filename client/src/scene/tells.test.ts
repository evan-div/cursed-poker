import { describe, expect, it } from 'vitest';
import { CALM, type PresenceFrame, type SeatTells } from '@cursed/shared';
import { STILL_MOTION, TELL_MOTION, TableTells, type TellMotion } from './tells.js';

/**
 * Other people's bodies, giving them away.
 *
 * The rule that matters is the last describe block: a seat's motion is a
 * function of that seat's broadcast tells and nothing else. The rest is whether
 * it reads as a body — still when calm, shaking when not, never more than a
 * person's hands could manage.
 */

const FRAME = 1 / 60;
const SHAKING: SeatTells = { tremor: 1, breathing: 1, sweat: 'SOAKED' };

function run(tells: TableTells, seconds: number, each?: (t: number) => void): void {
  for (let t = 0; t < seconds; t += FRAME) {
    tells.update(FRAME);
    each?.(t);
  }
}

function at(seatTells: SeatTells, seconds = 8): TableTells {
  const tells = new TableTells();
  tells.setTells(0, seatTells);
  run(tells, seconds);
  return tells;
}

const handSize = (m: TellMotion) => Math.hypot(m.hands[0].x, m.hands[0].y, m.hands[0].z);

describe('a calm body', () => {
  it('shows nothing for a seat nobody has heard of', () => {
    expect(new TableTells().motion(3)).toBe(STILL_MOTION);
  });

  it('keeps its hands and head perfectly still', () => {
    const tells = at(CALM);
    run(tells, 5, () => {
      const m = tells.motion(0);
      expect(handSize(m)).toBe(0);
      expect(Math.abs(m.head.yaw) + Math.abs(m.head.pitch)).toBe(0);
      expect(Math.abs(m.heldCards.roll)).toBe(0);
    });
  });

  it('still breathes, a little', () => {
    const tells = at(CALM);
    let most = 0;
    run(tells, 10, () => (most = Math.max(most, tells.motion(0).breath)));
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(TELL_MOTION.breathMetres.calm + 1e-9);
  });
});

describe('a frightened one', () => {
  it('shakes its hands, by millimetres', () => {
    const tells = at(SHAKING);
    const seen = new Set<string>();
    let most = 0;
    run(tells, 3, () => {
      const m = tells.motion(0);
      seen.add(m.hands[0].x.toFixed(6));
      most = Math.max(most, Math.abs(m.hands[0].x), Math.abs(m.hands[0].y), Math.abs(m.hands[0].z));
    });
    expect(seen.size).toBeGreaterThan(100);
    expect(most).toBeGreaterThan(TELL_MOTION.handMetres * 0.5);
    expect(most).toBeLessThanOrEqual(TELL_MOTION.handMetres + 1e-9);
  });

  it('shakes a raised pair harder than the hand under it', () => {
    // The cards are a lever on the hand: the same tremor moves their far edge
    // further, which is half of why held cards are where shaking shows.
    const tells = at(SHAKING);
    run(tells, 2, () => {
      const m = tells.motion(0);
      const card = Math.hypot(m.heldCards.offset.x, m.heldCards.offset.y, m.heldCards.offset.z);
      expect(card).toBeCloseTo(handSize(m) * TELL_MOTION.heldCardGain, 9);
      expect(Math.abs(m.heldCards.roll)).toBeLessThanOrEqual(TELL_MOTION.heldCardRoll);
    });
  });

  it('shakes a little tremor very little', () => {
    const peak = (tremor: number) => {
      const tells = at({ ...CALM, tremor });
      let most = 0;
      run(tells, 3, () => (most = Math.max(most, handSize(tells.motion(0)))));
      return most;
    };
    // Squared: the bottom step of the grid is somebody tense, not shaking.
    expect(peak(0.125)).toBeLessThan(peak(1) * 0.05);
    expect(peak(0.5)).toBeLessThan(peak(1) * 0.35);
  });

  it('breathes faster and deeper', () => {
    const cycles = (tells: TableTells) => {
      let count = 0;
      let rising = false;
      let last = 0;
      run(tells, 20, () => {
        const breath = tells.motion(0).breath;
        if (breath > last && !rising) count++;
        rising = breath > last;
        last = breath;
      });
      return count;
    };
    const calm = at(CALM);
    const panicked = at(SHAKING);
    expect(cycles(panicked)).toBeGreaterThan(cycles(calm) * 2);

    let deepest = 0;
    run(panicked, 5, () => (deepest = Math.max(deepest, panicked.motion(0).breath)));
    expect(deepest).toBeGreaterThan(TELL_MOTION.breathMetres.calm * 3);
  });

  it('eases between broadcast steps rather than jumping', () => {
    const tells = at(CALM);
    tells.setTells(0, SHAKING);
    tells.update(FRAME);
    expect(tells.motion(0).tremor).toBeGreaterThan(0);
    expect(tells.motion(0).tremor).toBeLessThan(0.1);
    run(tells, 5);
    expect(tells.motion(0).tremor).toBeGreaterThan(0.99);
  });

  it('sweats slowly, and dries slowly', () => {
    const tells = at(CALM);
    tells.setTells(0, SHAKING);
    run(tells, 1);
    expect(tells.motion(0).sweat).toBeLessThan(0.4);
    run(tells, 20);
    expect(tells.motion(0).sweat).toBeGreaterThan(0.98);
  });

  it('can be pinned for a screenshot and let go', () => {
    const tells = at(CALM);
    tells.force(0, SHAKING);
    tells.setTells(0, CALM); // the broadcast keeps arriving
    run(tells, 5);
    expect(tells.motion(0).tremor).toBeGreaterThan(0.99);

    tells.force(0, null);
    tells.setTells(0, CALM);
    run(tells, 5);
    expect(tells.motion(0).tremor).toBeLessThan(0.01);
  });
});

describe('what it is allowed to read', () => {
  function frame(seats: { seatIndex: number; tells: SeatTells; noise: number }[]): PresenceFrame {
    return {
      serverTime: 1,
      seats: seats.map(({ seatIndex, tells, noise }) => ({
        seatIndex,
        gaze: noise > 0.5 ? { kind: 'BOARD' } : { kind: 'SEAT', seatIndex: 0 },
        peek: noise,
        lift: noise / 2,
        lean: 1 - noise,
        handlingChips: noise > 0.3,
        stillMs: Math.round(noise * 9_000),
        present: true,
        tells,
      })),
      dealer: { posture: 'STILL', gaze: { kind: 'AWAY' }, twitchAt: 0 },
      dread: seats.reduce((sum, seat) => sum + seat.noise, 0) / seats.length,
    } as unknown as PresenceFrame;
  }

  it('moves a seat by its own tells, and by nothing else in the frame', () => {
    // Two tables. Seat 2 is told exactly the same thing on both; everything
    // else — every other seat's tells, everybody's posture, gaze, peek, lift,
    // stillness — is different on every frame. Seat 2 has to move identically.
    // If the renderer ever reached past a seat's own tells for something to
    // animate, this is where it shows.
    const a = new TableTells();
    const b = new TableTells();
    const script: SeatTells[] = [
      CALM,
      { tremor: 0.25, breathing: 0.5, sweat: 'DRY' },
      { tremor: 0.75, breathing: 1, sweat: 'DAMP' },
      SHAKING,
      { tremor: 0.5, breathing: 0.625, sweat: 'DAMP' },
    ];

    let seed = 99;
    const rand = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    const anyTells = (): SeatTells => ({
      tremor: Math.round(rand() * 8) / 8,
      breathing: Math.round(rand() * 8) / 8,
      sweat: (['DRY', 'DAMP', 'SOAKED'] as const)[Math.floor(rand() * 3)]!,
    });

    for (let i = 0; i < 600; i++) {
      const mine = script[Math.floor(i / 120)]!;
      a.applyPresence(
        frame([
          { seatIndex: 0, tells: CALM, noise: 0 },
          { seatIndex: 2, tells: mine, noise: 0.1 },
          { seatIndex: 4, tells: CALM, noise: 0 },
        ]),
      );
      b.applyPresence(
        frame([
          { seatIndex: 0, tells: anyTells(), noise: rand() },
          { seatIndex: 2, tells: mine, noise: rand() },
          { seatIndex: 4, tells: anyTells(), noise: rand() },
        ]),
      );
      a.update(FRAME);
      b.update(FRAME);
      expect(b.motion(2), `frame ${i}`).toEqual(a.motion(2));
    }
  });

  it('gives every seat its own shake, so a table does not tremble in unison', () => {
    const tells = new TableTells();
    for (const seat of [0, 1, 2]) tells.setTells(seat, SHAKING);
    run(tells, 4);
    const xs = [0, 1, 2].map((seat) => tells.motion(seat).hands[0].x);
    expect(new Set(xs.map((x) => x.toFixed(6))).size).toBe(3);
  });
});
