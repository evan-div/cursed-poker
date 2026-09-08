import type { MatchEvent } from '@cursed/shared';
import {
  DEALER_STATION,
  POT_POSITION,
  RADIUS,
  TABLE,
  boardCardPosition,
  seatPoint,
  stationPoint,
  type Vec3,
} from '../scene/layout.js';

/**
 * What the room sounds like, and where each sound is.
 *
 * Split from the thing that makes noise on purpose. Web Audio cannot run in a
 * test, but *which* cue an event produces and *where in the room it comes from*
 * are the parts with consequences, and both are plain data. So they live here,
 * pure and free of the browser, and `engine.ts` is only the small piece that
 * turns them into sound.
 *
 * The consequence that matters is the same one gaze has: **a sound is a thing
 * everyone can hear.** Audio is a side channel, and a cue that fired only for
 * one player, or that was louder when somebody held a big hand, would leak
 * across it. So the rule here is the presence channel's rule, restated for the
 * ears: every cue is triggered by something already public, and nothing is
 * positioned anywhere a person at this table could not see it happen.
 *
 * There is deliberately no cue for a player peeking. Lifting your cards is
 * public — it is *the* public act — but it is public to the eye, and something
 * you can hear from across a dark room without looking is a different and much
 * louder thing than something you have to be watching to catch. The whole
 * design is that you have to be looking.
 */

export const CUE_KINDS = [
  /** Cards leaving the Dealer's hands. */
  'DEAL',
  /** A community card turned over. */
  'BOARD',
  /** Chips pushed forward. */
  'CHIPS',
  /** A hand thrown away. */
  'MUCK',
  /** The pot pulled across the felt to somebody. */
  'POT',
  /** Something large moving at the head of the table. */
  'DEALER_RISE',
  /** The one that is not an event: a chair emptying for good. */
  'ELIMINATION',
] as const;
export type CueKind = (typeof CUE_KINDS)[number];

export interface Cue {
  kind: CueKind;
  /** Where in the room it happens, so it can be panned. */
  at: Vec3;
  /**
   * How loud, 0..1, before distance.
   *
   * Never derived from anything private. A bet's loudness follows the *size of
   * the bet*, which is on everybody's screen already.
   */
  gain: number;
}

/** Where the Dealer's hands are, which is where cards come from. */
function dealerHands(): Vec3 {
  return stationPoint(DEALER_STATION, RADIUS.body - 0.2, TABLE.surfaceHeight + 0.05);
}

/** Where a seat's chips sit. */
function chipsAt(seatIndex: number): Vec3 {
  return seatPoint(seatIndex, RADIUS.bet, TABLE.surfaceHeight + 0.02);
}

/**
 * What the room already knows, for scaling a sound to its occasion.
 *
 * The big blind rather than the pot, because it is the yardstick players
 * actually use: a thousand is a shove at level one and a limp at level nine,
 * and the difference is the blind, not the pot. It is also on everybody's HUD,
 * so nothing derived from it can leak.
 */
export interface CueContext {
  bigBlind: number;
}

/**
 * The cues one match event produces, if any.
 *
 * Most events make no sound at all. A poker table is quiet, and a game that
 * clicks and thuds at every state change stops being a room and becomes a
 * slot machine.
 */
export function cuesFor(event: MatchEvent, context: CueContext): Cue[] {
  switch (event.type) {
    case 'HOLE_CARDS_DEALT':
      // One sound per seat dealt to, from his hands rather than from the seats:
      // the cards are coming *from* somewhere, and that somewhere is him.
      return event.seats.map(() => ({ kind: 'DEAL', at: dealerHands(), gain: 0.5 }));

    case 'STREET_DEALT':
      return event.cards.map((_, index) => ({
        kind: 'BOARD',
        at: boardCardPosition(event.board.length - event.cards.length + index),
        gain: 0.6,
      }));

    case 'ANTE_POSTED':
    case 'BLIND_POSTED':
      return [{ kind: 'CHIPS', at: chipsAt(event.seatIndex), gain: 0.35 }];

    case 'PLAYER_ACTED':
      return [actionCue(event, context)];

    case 'UNCALLED_RETURNED':
      return [{ kind: 'CHIPS', at: chipsAt(event.seatIndex), gain: 0.3 }];

    case 'POT_AWARDED':
      return [{ kind: 'POT', at: POT_POSITION, gain: 0.55 }];

    case 'PLAYER_ELIMINATED':
      return [
        { kind: 'ELIMINATION', at: seatPoint(event.seatIndex, RADIUS.body, 1.0), gain: 0.8 },
      ];

    default:
      return [];
  }
}

/**
 * A player's action, as a sound.
 *
 * A fold is cards hitting the felt; everything else is chips. How loud follows
 * how many chips moved, which is a number already on everybody's screen — the
 * amount is public, so its loudness may be too.
 */
function actionCue(
  event: Extract<MatchEvent, { type: 'PLAYER_ACTED' }>,
  context: CueContext,
): Cue {
  const action = event.action;
  if (action.type === 'FOLD') {
    return {
      kind: 'MUCK',
      at: seatPoint(event.seatIndex, RADIUS.holeCards, TABLE.surfaceHeight),
      gain: 0.4,
    };
  }
  if (action.type === 'CHECK') {
    // A knuckle on the table. Quiet, and the only sound a check makes.
    return { kind: 'CHIPS', at: chipsAt(event.seatIndex), gain: 0.18 };
  }

  const amount = 'amount' in action ? action.amount : 0;
  return { kind: 'CHIPS', at: chipsAt(event.seatIndex), gain: chipGain(amount, context.bigBlind) };
}

/**
 * How loud a pile of chips is, measured in big blinds.
 *
 * Saturating rather than linear: the difference between one blind and five is
 * most of what a table hears, and the difference between forty and eighty is
 * nothing — both are already somebody shoving.
 */
export function chipGain(amount: number, bigBlind: number): number {
  if (!(amount > 0) || !(bigBlind > 0)) return 0.18;
  const blinds = amount / bigBlind;
  return 0.26 + (1 - Math.exp(-blinds / 6)) * 0.44;
}

/** The one cue nothing in the match emits: the Dealer coming up out of his chair. */
export function dealerRiseCue(): Cue {
  return {
    kind: 'DEALER_RISE',
    at: stationPoint(DEALER_STATION, RADIUS.body, 1.6),
    gain: 0.7,
  };
}
