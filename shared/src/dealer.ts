import type { GazeTarget } from './presence.js';

/**
 * The Dealer, and the dread he keeps.
 *
 * He is a body at the table like any other, and he is replicated the same way
 * and for the same reason: **everyone has to see the same one.** "The Dealer
 * turned his head toward seat three" is only worth anything if it is a fact
 * about the room rather than a thing one player's client decided to draw. Six
 * clients each running their own idea of him would produce six different
 * evenings, and nobody could ever say *did you see that?* and be answered.
 *
 * So he rides the presence channel — the one that already carries bodies,
 * identically, to everybody, at a fixed tick. Deciding where he looks is the
 * server's job; playing the animation is the client's.
 *
 * What is *not* here, and must never be: anything he could only know by looking
 * at the cards. He may watch the player who is acting, or the one who just
 * lifted their hand, because those are things a person at this table can see.
 * He may not watch the player who was dealt aces. `dealer.test.ts` asserts that
 * by running the same public situation over two different decks and requiring
 * him to behave identically.
 */

/**
 * What his body is doing. One of these at a time, and he holds it.
 *
 * A vocabulary rather than an animation name, for the same reason gaze is a
 * subject rather than an angle: the server says what he is *doing* and the
 * client works out what that looks like from where it happens to be standing.
 */
export const DEALER_POSTURES = [
  /** Motionless, hands at the rail. The default, and most of the evening. */
  'STILL',
  /** Working: cards leaving his hands, chips moving to the pot. */
  'DEALING',
  /** Head up, following somebody. */
  'WATCHING',
  /** Bent forward over the felt, toward whoever he is watching. */
  'LEANING',
  /** Standing. Nothing good has ever followed this. */
  'RISEN',
] as const;
export type DealerPosture = (typeof DEALER_POSTURES)[number];

/**
 * The Dealer as everybody sees him.
 *
 * Note the absence, again: no hand strength, no card, no read on anybody. What
 * a player infers from where he is looking is a player's business.
 */
export interface DealerPresence {
  /** Who or what he is looking at — the same vocabulary as a player's gaze. */
  gaze: GazeTarget;
  posture: DealerPosture;
  /**
   * How long he has held completely still, in milliseconds.
   *
   * The number the horror actually lives in. A person shifts; he does not, and
   * the longer that goes on the more obvious it becomes that the thing at the
   * head of the table is only shaped like one of you.
   */
  stillMs: number;
  /**
   * Epoch milliseconds of his most recent twitch, or null.
   *
   * A twitch is an *event*, not a state: it is over in a fraction of a second,
   * and a twelve-hertz frame would miss it half the time if it were a boolean.
   * Sending the timestamp means a client can tell "he twitched, and I have not
   * played it yet" from "he twitched, and I already did" — and a client that
   * joins an hour in does not play an hour-old twitch on its first frame.
   */
  twitchAt: number | null;
}

export const DEALER = {
  /**
   * How long a twitch stays worth playing, in milliseconds.
   *
   * Past this a client that has just connected, or just come back from a
   * suspended tab, drops it instead of jerking him for something that happened
   * while nobody was looking.
   */
  twitchFreshMs: 900,
  /** How long a twitch takes to play out, in milliseconds. */
  twitchMs: 180,
  /**
   * How long he holds a gaze, in milliseconds, at no dread and at full.
   *
   * It gets *longer*, which is the whole point. A head that flicks about is
   * busy; a head that has been pointed at you without moving for eleven
   * seconds is something else. The unnerving direction is the still one.
   */
  holdMsCalm: 3_200,
  holdMsDread: 11_000,
  /** Chance, per decision, that he twitches instead of settling cleanly. */
  twitchChanceCalm: 0.05,
  twitchChanceDread: 0.35,
  /**
   * Chance he simply keeps watching whoever he was watching.
   *
   * Without this he re-rolls a target every time and reads as a sprinkler. A
   * Dealer who *stays* on you after the reason to has passed is the one worth
   * building.
   */
  stayChance: 0.4,
  /** Chance he looks at a player who is lifting their cards right now. */
  noticePeekChance: 0.55,
  /** Dread above which he will stand between hands. */
  riseAbove: 0.82,
  /** Dread above which he leans in on whoever is acting. */
  leanAbove: 0.45,
} as const;

/**
 * Everything the room's dread is computed from.
 *
 * All three only ever go up, which is deliberate and is the design statement:
 * **the room does not get better.** A player who survives a bad stretch has not
 * earned the lights back. There is no input here that can fall, so there is no
 * arrangement of play that lowers the number.
 */
export interface DreadInput {
  /** How many sat down at the start. */
  startingPlayers: number;
  /** How many the Dealer has taken. */
  eliminated: number;
  /** How long the match has been running, in milliseconds. */
  elapsedMs: number;
  /** How many pieces of themselves players have given up. Phase 9 fills this. */
  sacrifices: number;
}

/**
 * How far in each input can push, and how long it takes to get there.
 *
 * The weights deliberately total more than one. Any single source maxed out
 * leaves the room short of the worst it gets; any two together arrive. A long
 * quiet match still darkens, because it is long.
 */
export const DREAD = {
  /** Match length that alone accounts for `timeWeight`, in milliseconds. */
  fullTimeMs: 90 * 60 * 1000,
  timeWeight: 0.45,
  /** Reached when everyone but one player is gone. */
  emptyChairWeight: 0.4,
  /** Sacrifices that alone account for `sacrificeWeight`. */
  fullSacrifices: 6,
  sacrificeWeight: 0.35,
} as const;

/**
 * The room's dread, 0..1.
 *
 * A pure function of facts every client already knows, which is why it is safe
 * to broadcast and why it needs no smoothing: it moves when the match moves.
 * Clients hang lighting, fog and the Dealer's tempo off it.
 */
export function dreadLevel(input: DreadInput): number {
  const time = saturate(input.elapsedMs / DREAD.fullTimeMs) * DREAD.timeWeight;

  // One player left is the end of the match, so the last elimination is the
  // one that completes the chair count rather than the one after it.
  const chairs = Math.max(input.startingPlayers - 1, 1);
  const empty = saturate(input.eliminated / chairs) * DREAD.emptyChairWeight;

  const given = saturate(input.sacrifices / DREAD.fullSacrifices) * DREAD.sacrificeWeight;

  return saturate(time + empty + given);
}

/** Where a value sits between two endpoints, given a 0..1 mix. */
export function blend(calm: number, dread: number, level: number): number {
  return calm + (dread - calm) * saturate(level);
}

function saturate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
