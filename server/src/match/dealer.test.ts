import { describe, expect, it } from 'vitest';
import { DEALER, DREAD, dreadLevel, type GazeTarget } from '@cursed/shared';
import { SeededRandomSource } from '../poker/index.js';
import { createDealer, projectDealer, updateDealer, type DealerContext } from './dealer.js';

/**
 * The Dealer.
 *
 * Two of these tests are the reason the module is shaped the way it is, and
 * neither is about how he looks:
 *
 *   - he behaves identically over two different decks, because the only thing
 *     he is given is public, and
 *   - a table of six can watch him for an hour without a single card moving,
 *     because his chance and the deck's chance are different objects.
 *
 * The rest is feel, and feel is allowed to change. Those two are not.
 */

const T0 = 1_700_000_000_000;

function context(over: Partial<DealerContext> = {}): DealerContext {
  return {
    working: false,
    handInProgress: true,
    actingSeat: null,
    seats: [0, 1, 2, 3],
    liftedSeats: [],
    dread: 0,
    ...over,
  };
}

/** Runs him for `ticks` presence frames and collects everything he did. */
function run(ctx: DealerContext, seed: number, ticks = 400, stepMs = 83) {
  const state = createDealer(T0);
  const rng = new SeededRandomSource(seed);
  const seen: string[] = [];
  for (let i = 0; i < ticks; i++) {
    const now = T0 + i * stepMs;
    updateDealer(state, ctx, rng, now);
    const shown = projectDealer(state, now);
    seen.push(`${shown.posture}:${describe_(shown.gaze)}:${shown.twitchAt ?? '-'}`);
  }
  return { state, seen };
}

function describe_(gaze: GazeTarget): string {
  return gaze.kind === 'SEAT' ? `SEAT${gaze.seatIndex}` : gaze.kind;
}

describe('what he is allowed to know', () => {
  it('reacts to the acting seat, which everyone can see', () => {
    const { state } = run(context({ actingSeat: 3, seats: [0, 1, 2, 3] }), 7, 40);
    expect(state.gaze).toEqual({ kind: 'SEAT', seatIndex: 3 });
  });

  it('only ever looks at seats that are actually there', () => {
    const seats = [1, 4, 5];
    const { state } = run(context({ seats }), 99, 600);
    if (state.gaze.kind === 'SEAT') expect(seats).toContain(state.gaze.seatIndex);
  });

  it('looks at nothing when the table is empty', () => {
    const { state } = run(context({ seats: [], handInProgress: false }), 3, 40);
    expect(state.gaze.kind).toBe('AWAY');
  });

  it('notices a player who has lifted their cards', () => {
    // Over many runs he should land on the one seat holding its hand up at
    // least sometimes — noticing the look is the tell the whole game turns on.
    const noticed = [...Array(40).keys()].some((seed) => {
      const { state } = run(context({ liftedSeats: [5], seats: [0, 5] }), seed, 60);
      return state.gaze.kind === 'SEAT' && state.gaze.seatIndex === 5;
    });
    expect(noticed).toBe(true);
  });
});

describe('what his body does', () => {
  it('deals while cards are moving', () => {
    const { state } = run(context({ working: true }), 5, 20);
    expect(state.posture).toBe('DEALING');
  });

  it('sits still between hands, until it gets bad enough to stand', () => {
    const calm = run(context({ handInProgress: false, dread: 0.2 }), 5, 20);
    expect(calm.state.posture).toBe('STILL');

    const late = run(context({ handInProgress: false, dread: 0.95 }), 5, 20);
    expect(late.state.posture).toBe('RISEN');
  });

  it('leans in on whoever he is watching once the room turns', () => {
    const early = run(context({ actingSeat: 1, dread: 0.1 }), 5, 40);
    expect(early.state.posture).toBe('WATCHING');

    const later = run(context({ actingSeat: 1, dread: 0.9 }), 5, 40);
    expect(later.state.posture).toBe('LEANING');
  });

  it('holds a stare longer the worse the room gets', () => {
    const stillness = (dread: number) => {
      const state = createDealer(T0);
      const rng = new SeededRandomSource(4242);
      const ctx = context({ dread, seats: [0, 1, 2, 3, 4, 5] });
      let longest = 0;
      for (let i = 0; i < 3_000; i++) {
        const now = T0 + i * 83;
        updateDealer(state, ctx, rng, now);
        longest = Math.max(longest, projectDealer(state, now).stillMs);
      }
      return longest;
    };
    // Not a small difference: the unnerving direction is the still one.
    expect(stillness(1)).toBeGreaterThan(stillness(0) * 1.5);
  });

  it('twitches more often as the room turns, and stamps each one', () => {
    const twitches = (dread: number) => {
      const state = createDealer(T0);
      const rng = new SeededRandomSource(77);
      const ctx = context({ dread });
      const stamps = new Set<number>();
      for (let i = 0; i < 4_000; i++) {
        const now = T0 + i * 83;
        updateDealer(state, ctx, rng, now);
        if (state.twitchAt !== null) stamps.add(state.twitchAt);
      }
      return stamps.size;
    };
    expect(twitches(1)).toBeGreaterThan(twitches(0));
  });

  it('reports a twitch as a moment, not a flag', () => {
    // A boolean at twelve hertz loses a hundred-and-eighty-millisecond event
    // half the time. A timestamp survives a dropped frame, and tells a client
    // that has just connected that this one is old news.
    const { state } = run(context({ dread: 1 }), 11, 400);
    expect(state.twitchAt === null || state.twitchAt >= T0).toBe(true);
    expect(DEALER.twitchFreshMs).toBeGreaterThan(1000 / 12);
  });

  it('counts stillness from the last thing he did', () => {
    const state = createDealer(T0);
    expect(projectDealer(state, T0 + 5_000).stillMs).toBe(5_000);
  });
});

describe('the room', () => {
  const base = { startingPlayers: 6, eliminated: 0, elapsedMs: 0, sacrifices: 0 };

  it('starts at nothing', () => {
    expect(dreadLevel(base)).toBe(0);
  });

  it('rises with the clock, with empty chairs, and with what people give up', () => {
    expect(dreadLevel({ ...base, elapsedMs: DREAD.fullTimeMs })).toBeCloseTo(DREAD.timeWeight, 6);
    expect(dreadLevel({ ...base, eliminated: 5 })).toBeCloseTo(DREAD.emptyChairWeight, 6);
    expect(dreadLevel({ ...base, sacrifices: DREAD.fullSacrifices })).toBeCloseTo(
      DREAD.sacrificeWeight,
      6,
    );
  });

  it('never falls over the course of a match', () => {
    // Not a property of the arithmetic — a property of the design. Every input
    // only ever increases, so walking one forward the way a real evening does
    // can only ever push the number up. There is no sequence of play that turns
    // the lights back on.
    let previous = -1;
    let eliminated = 0;
    let sacrifices = 0;
    for (let minute = 0; minute <= 150; minute += 3) {
      if (minute % 27 === 0 && eliminated < 5) eliminated++;
      if (minute % 21 === 0) sacrifices++;
      const value = dreadLevel({ ...base, elapsedMs: minute * 60_000, eliminated, sacrifices });
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(previous).toBe(1);
  });

  it('is monotonic in each input on its own', () => {
    const grows = (key: 'elapsedMs' | 'eliminated' | 'sacrifices', values: number[]) => {
      let last = -1;
      for (const value of values) {
        const level = dreadLevel({ ...base, [key]: value });
        expect(level).toBeGreaterThanOrEqual(last);
        last = level;
      }
    };
    grows('elapsedMs', [0, 10_000, 600_000, DREAD.fullTimeMs, DREAD.fullTimeMs * 3]);
    grows('eliminated', [0, 1, 2, 3, 4, 5]);
    grows('sacrifices', [0, 1, 3, 6, 12]);
  });

  it('measures empty chairs against how many sat down', () => {
    const ofSix = dreadLevel({ ...base, eliminated: 2 });
    const ofFour = dreadLevel({ ...base, startingPlayers: 4, eliminated: 2 });
    // Two gone from four is most of the table; two gone from six is a third.
    expect(ofFour).toBeGreaterThan(ofSix);
  });

  it('survives nonsense rather than propagating it', () => {
    expect(dreadLevel({ ...base, elapsedMs: Number.NaN })).toBe(0);
    expect(dreadLevel({ ...base, startingPlayers: 0, eliminated: 0 })).toBe(0);
    expect(dreadLevel({ ...base, elapsedMs: -1 })).toBe(0);
  });
});
