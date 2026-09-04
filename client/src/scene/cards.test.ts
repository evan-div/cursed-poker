import { describe, expect, it } from 'vitest';
import { cardsFromString, type ClientView, type SeatView } from '@cursed/shared';
import { readableFromYaw, visibleFaces } from './cards.js';
import { STATION_COUNT, stationPoint } from './layout.js';

const seat = (overrides: Partial<SeatView> = {}): SeatView => ({
  seatIndex: 0,
  playerId: 'them',
  displayName: 'Them',
  stack: 10_000,
  betThisRound: 0,
  folded: false,
  allIn: false,
  inHand: true,
  connected: true,
  revealedCards: null,
  handCategory: null,
  bestFive: null,
  ...overrides,
});

const view = (overrides: Partial<ClientView['you']> = {}): ClientView =>
  ({
    you: { playerId: 'me', seatIndex: 1, holeCards: null, legalActions: null, ...overrides },
  }) as ClientView;

describe('which faces the table may show', () => {
  it('shows the viewer their own cards', () => {
    const mine = cardsFromString('AsKd');
    const faces = visibleFaces(seat({ playerId: 'me' }), view({ holeCards: mine }));
    expect(faces).toEqual(mine);
  });

  it('shows nothing for an opponent in a live hand', () => {
    const faces = visibleFaces(seat({ playerId: 'them' }), view({ holeCards: cardsFromString('AsKd') }));
    expect(faces).toEqual([null, null]);
  });

  it('shows an opponent only what poker revealed at showdown', () => {
    const shown = cardsFromString('7h7s');
    const faces = visibleFaces(seat({ playerId: 'them', revealedCards: shown }), view());
    expect(faces).toEqual(shown);
  });

  it('never invents a card the server did not send', () => {
    // Every combination of ownership and reveal state, and the answer is always
    // drawn from the view or is null. There is no other source available.
    for (const playerId of ['me', 'them']) {
      for (const revealed of [null, cardsFromString('2c3c')]) {
        for (const own of [null, cardsFromString('AsKd')]) {
          const faces = visibleFaces(
            seat({ playerId, revealedCards: revealed }),
            view({ holeCards: own }),
          );
          const permitted = new Set([...(revealed ?? []), ...(playerId === 'me' ? (own ?? []) : [])]);
          for (const card of faces) {
            if (card !== null) expect(permitted.has(card)).toBe(true);
          }
        }
      }
    }
  });

  it('prefers the public reveal over the viewer\'s own copy', () => {
    // A showdown makes the cards public; the viewer's own copy is the same data.
    const mine = cardsFromString('AsKd');
    const faces = visibleFaces(
      seat({ playerId: 'me', revealedCards: mine }),
      view({ holeCards: mine }),
    );
    expect(faces).toEqual(mine);
  });

  it('always answers with exactly two slots', () => {
    expect(visibleFaces(seat(), view())).toHaveLength(2);
    expect(visibleFaces(seat({ playerId: 'me' }), view({ holeCards: [] }))).toHaveLength(2);
  });
});

describe('reading text off the table', () => {
  it('faces cards the same way the person at that station is looking', () => {
    // Flat text reads correctly from a station when the card's yaw matches the
    // camera yaw for that seat — the same formula, deliberately.
    for (let station = 0; station < STATION_COUNT; station++) {
      const yaw = readableFromYaw(station);
      const at = stationPoint(station, 1);
      // "Up" on the card points away from the reader, toward the middle.
      const up = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
      expect(up.x).toBeCloseTo(-at.x, 6);
      expect(up.z).toBeCloseTo(-at.z, 6);
    }
  });
});
