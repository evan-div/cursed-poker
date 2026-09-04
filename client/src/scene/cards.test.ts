import { describe, expect, it } from 'vitest';
import { Euler, Vector3 } from 'three';
import { cardsFromString, type ClientView, type SeatView } from '@cursed/shared';
import { holeCardPose, holeCardRest, readableFromYaw, visibleFaces } from './cards.js';
import { RADIUS, STATION_COUNT, seatPoint, stationPoint } from './layout.js';

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
    you: { playerId: 'me', seatIndex: 1, holeCards: null, hasPeeked: false, legalActions: null, ...overrides },
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


// ---------------------------------------------------------------------------
// The peek pose
// ---------------------------------------------------------------------------

const SEATS = [0, 1, 2, 3, 4, 5];

/**
 * The direction a card's printed face points, in world space.
 *
 * Built from a real `Euler` in the renderer's own rotation order rather than
 * from trigonometry restated in the test, for the reason `layout.test.ts` gives:
 * a convention asserted twice is not checked once.
 */
function faceNormal(seatIndex: number, cardIndex: number, exposure: number): Vector3 {
  const pose = holeCardPose(seatIndex, cardIndex, exposure);
  const euler = new Euler(pose.rotationX, pose.rotationY, 0, 'YXZ');
  return new Vector3(0, 0, 1).applyEuler(euler).normalize();
}

/** From the middle of the table toward a seat: the way its owner is sitting. */
function outward(seatIndex: number): Vector3 {
  const at = seatPoint(seatIndex, RADIUS.holeCards);
  return new Vector3(at.x, 0, at.z).normalize();
}

describe('lifting a card at the table', () => {
  it('lies flat and face up when nobody is touching it', () => {
    for (const seatIndex of SEATS) {
      expect(faceNormal(seatIndex, 0, 0).y).toBeCloseTo(1, 6);
      expect(faceNormal(seatIndex, 1, 0).y).toBeCloseTo(1, 6);
    }
  });

  it('turns the face toward the person holding it, at every seat', () => {
    for (const seatIndex of SEATS) {
      const normal = faceNormal(seatIndex, 0, 1);
      expect(
        normal.dot(outward(seatIndex)),
        `seat ${seatIndex} tilted its card the wrong way`,
      ).toBeGreaterThan(0.5);
    }
  });

  it('points a lifted card at its owner before anybody else', () => {
    // Seats are only about 51 degrees apart on a ring of seven, so a neighbour
    // is always somewhat in front of a tilted card — exactly as at a real table,
    // where the person beside you can half-see your hand if you are careless.
    // What must hold is that the owner has the best view of it by some margin.
    for (const seatIndex of SEATS) {
      const normal = faceNormal(seatIndex, 0, 1);
      const mine = normal.dot(outward(seatIndex));
      for (const other of SEATS) {
        if (other === seatIndex) continue;
        expect(
          mine - normal.dot(outward(other)),
          `seat ${other} saw seat ${seatIndex}'s card as well as they did`,
        ).toBeGreaterThan(0.1);
      }
    }

    // And it never matters, because the face itself is not on their client:
    // `visibleFaces` gives an opponent null, whatever the geometry does.
    expect(visibleFaces(seat({ playerId: 'them' }), view({ holeCards: cardsFromString('AsKd') })))
      .toEqual([null, null]);
  });

  it('rises further the harder it is pulled, and stops', () => {
    let previous = -1;
    for (const exposure of [0, 0.25, 0.5, 0.75, 1]) {
      const height = holeCardPose(3, 0, exposure).position.y;
      expect(height).toBeGreaterThanOrEqual(previous);
      previous = height;
    }
    // Past fully lifted is still fully lifted.
    expect(holeCardPose(3, 0, 5).position.y).toBeCloseTo(holeCardPose(3, 0, 1).position.y, 9);
    expect(holeCardPose(3, 0, -5).position.y).toBeCloseTo(holeCardPose(3, 0, 0).position.y, 9);
  });

  it('leads with the near card, so a small lift shows one rank', () => {
    const near = holeCardPose(1, 0, 0.3).position.y;
    const far = holeCardPose(1, 1, 0.3).position.y;
    expect(near).toBeGreaterThan(far);
  });

  it('pivots on the near edge rather than sinking through the felt', () => {
    for (const seatIndex of SEATS) {
      const rest = holeCardRest(seatIndex, 0);
      const lifted = holeCardPose(seatIndex, 0, 1).position;
      expect(lifted.y).toBeGreaterThan(rest.y);

      // The centre of the card slides toward its owner as the far edge rises.
      const moved = new Vector3(lifted.x - rest.x, 0, lifted.z - rest.z);
      expect(moved.length()).toBeGreaterThan(0);
      expect(moved.normalize().dot(outward(seatIndex))).toBeGreaterThan(0.9);
    }
  });
});
