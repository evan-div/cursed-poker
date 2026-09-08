import { describe, expect, it } from 'vitest';
import type { MatchEvent } from '@cursed/shared';
import { chipGain, cuesFor, dealerRiseCue, type Cue } from './cues.js';
import { RADIUS, TABLE, seatPoint } from '../scene/layout.js';

/**
 * What the room sounds like.
 *
 * Sound is a side channel, and the test that matters is the same one the
 * presence frame gets: **nothing may be audible that is not already public.**
 * A cue that fired only for the player holding a big hand, or that was louder
 * when the cards were good, would leak across the ears — and nobody would think
 * to look for it in a renderer.
 *
 * So the fixture below hands every event a *different* set of cards and
 * requires the sound to come out identical, exactly as `dealer.test.ts` does
 * for where the Dealer looks.
 */

const BLIND = { bigBlind: 100 };

function acted(over: Partial<Extract<MatchEvent, { type: 'PLAYER_ACTED' }>> = {}): MatchEvent {
  return {
    type: 'PLAYER_ACTED',
    seatIndex: 2,
    requested: { type: 'CALL' },
    action: { type: 'CALL', amount: 100 },
    stack: 9_000,
    allIn: false,
    ...over,
  } as MatchEvent;
}

function summarise(cues: Cue[]): string[] {
  return cues.map(
    (cue) =>
      `${cue.kind}@${cue.at.x.toFixed(3)},${cue.at.y.toFixed(3)},${cue.at.z.toFixed(3)}` +
      `:${cue.gain.toFixed(3)}`,
  );
}

describe('nothing audible that is not already visible', () => {
  it('sounds identical whatever the cards are', () => {
    // The same street, dealt twice out of different decks. Card *identity* must
    // not reach the mixer: what a table hears is three cards landing, not which
    // three. Encoded as: the cue list is byte-for-byte the same.
    const a: MatchEvent = {
      type: 'STREET_DEALT',
      street: 'FLOP',
      cards: [0, 1, 2],
      board: [0, 1, 2],
    };
    const b: MatchEvent = {
      type: 'STREET_DEALT',
      street: 'FLOP',
      cards: [48, 33, 7],
      board: [48, 33, 7],
    };
    expect(summarise(cuesFor(b, BLIND))).toEqual(summarise(cuesFor(a, BLIND)));
  });

  it('says nothing at all when somebody looks at their hand', () => {
    // Peeking is the most public act at this table and it is deliberately
    // silent. Something you can hear across a dark room without looking is a
    // different and much louder thing than something you have to be watching
    // to catch, and the whole design is that you have to be watching.
    expect(cuesFor({ type: 'HOLE_CARDS_DEALT', seats: [0, 1] }, BLIND).every((c) => c.kind === 'DEAL')).toBe(
      true,
    );
    // And no event in the protocol carries a peek at all, so there is nothing
    // here that could accidentally start making one audible.
    const noisy = (['SHOWDOWN', 'BETTING_ROUND_CLOSED', 'ACTION_REQUIRED'] as const).flatMap(
      (type) => cuesFor({ type } as MatchEvent, BLIND),
    );
    expect(noisy).toEqual([]);
  });

  it('is quiet about most of what happens', () => {
    // A room that clicks at every state change stops being a room.
    for (const type of ['HAND_STARTED', 'SHOWDOWN', 'HAND_COMPLETE', 'BETTING_ROUND_CLOSED']) {
      expect(cuesFor({ type } as MatchEvent, BLIND), type).toEqual([]);
    }
  });
});

describe('where a sound comes from', () => {
  it('puts a seat\u2019s chips in front of that seat', () => {
    for (const seatIndex of [0, 1, 2, 3, 4, 5]) {
      const [cue] = cuesFor(acted({ seatIndex }), BLIND);
      const bet = seatPoint(seatIndex, RADIUS.bet, TABLE.surfaceHeight + 0.02);
      expect(cue!.at.x).toBeCloseTo(bet.x, 6);
      expect(cue!.at.z).toBeCloseTo(bet.z, 6);
    }
  });

  it('puts dealt cards at the Dealer rather than at the seats they land on', () => {
    // They are coming *from* somewhere, and that somewhere is him.
    const cues = cuesFor({ type: 'HOLE_CARDS_DEALT', seats: [0, 3, 5] }, BLIND);
    expect(cues).toHaveLength(3);
    const first = cues[0]!;
    for (const cue of cues) expect(cue.at).toEqual(first.at);
    // Behind the middle of the table, where he stands.
    expect(first.at.z).toBeLessThan(0);
  });

  it('lays the board out across the felt, one sound per card', () => {
    const flop = cuesFor(
      { type: 'STREET_DEALT', street: 'FLOP', cards: [0, 1, 2], board: [0, 1, 2] },
      BLIND,
    );
    expect(flop).toHaveLength(3);
    expect(new Set(flop.map((c) => c.at.x)).size).toBe(3);

    // The turn is the fourth card, so it sounds from the fourth position.
    const turn = cuesFor(
      { type: 'STREET_DEALT', street: 'TURN', cards: [9], board: [0, 1, 2, 9] },
      BLIND,
    );
    expect(turn).toHaveLength(1);
    expect(turn[0]!.at.x).toBeGreaterThan(flop[2]!.at.x);
  });

  it('has the Dealer stand up above the table, not on it', () => {
    expect(dealerRiseCue().at.y).toBeGreaterThan(1.2);
  });
});

describe('how loud', () => {
  it('measures chips in big blinds, not in chips', () => {
    // A thousand is a shove at level one and a limp at level nine.
    const early = chipGain(1_000, 100);
    const late = chipGain(1_000, 4_000);
    expect(early).toBeGreaterThan(late);
  });

  it('saturates, because everything past a shove is a shove', () => {
    const shove = chipGain(40 * 100, 100);
    const bigger = chipGain(400 * 100, 100);
    expect(bigger - shove).toBeLessThan(0.02);
    expect(bigger).toBeLessThanOrEqual(0.7);
  });

  it('keeps every cue inside the mixer', () => {
    const every: MatchEvent[] = [
      { type: 'HOLE_CARDS_DEALT', seats: [0, 1, 2] },
      { type: 'STREET_DEALT', street: 'FLOP', cards: [1, 2, 3], board: [1, 2, 3] },
      { type: 'ANTE_POSTED', seatIndex: 1, amount: 25, allIn: false },
      acted({ action: { type: 'FOLD' } }),
      acted({ action: { type: 'CHECK' } }),
      acted({ action: { type: 'RAISE', to: 9_999_999, amount: 9_999_999 } }),
      { type: 'UNCALLED_RETURNED', seatIndex: 4, amount: 500 },
      { type: 'POT_AWARDED', potIndex: 0, seatIndex: 3, amount: 900, oddChip: false },
      { type: 'PLAYER_ELIMINATED', playerId: 'p1', seatIndex: 5, place: 4 },
    ];
    for (const event of every) {
      for (const cue of cuesFor(event, BLIND)) {
        expect(cue.gain, `${event.type} gain`).toBeGreaterThan(0);
        expect(cue.gain, `${event.type} gain`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('survives a blind it was never told about', () => {
    // The first events of a match can arrive before the level does.
    expect(chipGain(500, 0)).toBeGreaterThan(0);
    expect(Number.isFinite(chipGain(500, 0))).toBe(true);
  });
});
