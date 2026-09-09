import {
  DEALER,
  GAZE_AWAY,
  blend,
  gazeEquals,
  type DealerPosture,
  type DealerPresence,
  type GazeTarget,
} from '@cursed/shared';
import type { RandomSource } from '../poker/index.js';

/**
 * What the Dealer does, decided here and nowhere else.
 *
 * He is the room's one deliberate presence, so his behaviour is authoritative
 * for the same reason the pot is: everybody has to be looking at the same thing.
 * The client draws him; it does not get a vote on what he does.
 *
 * Two rules hold this module in place, and both are load-bearing.
 *
 * **He cannot see the cards.** `DealerContext` is the entire world he reacts to,
 * and there is nothing in it a player at this table could not also see: who is
 * acting, who is lifting their hand, how many are left, what street it is. He
 * may stare at the man who just raised. He may not stare at the man who was
 * dealt aces, and the type of his input is what makes that true rather than a
 * promise in a comment. `dealer.test.ts` runs the same public situation over two
 * different decks and requires him to behave identically.
 *
 * **His chance is not the deck's chance.** He draws from a `RandomSource` of his
 * own, never the one the shuffle uses. Sharing it would mean the deck depended
 * on how often he twitched — the supernatural layer reaching into the cards
 * through a side door, which is the one thing this project is built not to
 * allow. `match.ts` constructs the two separately and a test asserts the deck is
 * unchanged by an hour of him fidgeting.
 *
 * Plain data plus free functions, like `presence.ts`, so the whole thing
 * snapshots and replays with the rest of the match.
 */

export interface DealerState {
  gaze: GazeTarget;
  posture: DealerPosture;
  /** Epoch ms when cards or chips last moved through his hands, or null. */
  dealtAt: number | null;
  /**
   * Epoch ms when he first stood, or null.
   *
   * Set once and never cleared, because he does not sit back down. See
   * `choosePosture`.
   */
  roseAt: number | null;
  /** Epoch ms when he last changed anything at all. */
  lastMovedAt: number;
  /** Epoch ms when he will next consider doing something. */
  nextDecisionAt: number;
  /** Epoch ms of his most recent twitch, or null. */
  twitchAt: number | null;
}

/**
 * The world he reacts to. Public facts only — see the note above.
 *
 * Anything added here is something the Dealer is allowed to know, so adding to
 * it is a decision about the game rather than a refactor.
 */
export interface DealerContext {
  /** Epoch ms when cards or chips last moved through his hands, or null. */
  dealtAt: number | null;
  /** Now, so a window can be measured against `dealtAt`. */
  now: number;
  /** Whether a hand is live at all. */
  handInProgress: boolean;
  /** Whose turn it is, or null. */
  actingSeat: number | null;
  /** Seats still sitting at the table. */
  seats: number[];
  /** Seats with their cards off the felt right now. */
  liftedSeats: number[];
  /** The room's dread, 0..1. */
  dread: number;
}

export function createDealer(now: number): DealerState {
  return {
    gaze: GAZE_AWAY,
    posture: 'STILL',
    dealtAt: null,
    roseAt: null,
    lastMovedAt: now,
    nextDecisionAt: now,
    twitchAt: null,
  };
}

/**
 * Moves him on, if he feels like it.
 *
 * Called on the presence tick, twelve times a second, and does nothing at all
 * on almost all of them: he decides on his own schedule, and that schedule gets
 * *slower* as the room gets worse. A Dealer who reconsiders twelve times a
 * second is a nervous one.
 */
export function updateDealer(
  state: DealerState,
  context: DealerContext,
  rng: RandomSource,
  now: number,
): void {
  const posture = choosePosture(state, context);
  if (posture !== state.posture) {
    if (posture === 'RISEN') state.roseAt = now;
    state.posture = posture;
    state.lastMovedAt = now;
  }

  if (now < state.nextDecisionAt) return;

  const gaze = chooseGaze(state, context, rng);
  if (!gazeEquals(gaze, state.gaze)) {
    state.gaze = gaze;
    state.lastMovedAt = now;
  }

  // A twitch is not a decision, it is a failure of one: something in him moves
  // that a person's body would not, on the way to holding still again.
  const twitchChance = blend(DEALER.twitchChanceCalm, DEALER.twitchChanceDread, context.dread);
  if (chance(rng, twitchChance)) {
    state.twitchAt = now;
    state.lastMovedAt = now;
  }

  // How long until he thinks about it again — longer the worse things get, so
  // that a held stare outlasts any reason he might have had for starting it.
  const hold = blend(DEALER.holdMsCalm, DEALER.holdMsDread, context.dread);
  // Spread either side of the hold so he is never quite metronomic.
  state.nextDecisionAt = now + Math.round(hold * (0.7 + rng.nextInt(600) / 1000));
}

/**
 * What he is doing with his body.
 *
 * Re-derived every tick rather than remembered, because posture is a function
 * of the situation and the situation is authoritative. Only the gaze has
 * memory, because only the gaze is a *choice*.
 */
function choosePosture(state: DealerState, context: DealerContext): DealerPosture {
  // He stands between hands, and then he never sits down again.
  //
  // Without the second half this posture was effectively unreachable: the gap
  // between hands is a second and a half, and only the last few of a match are
  // dark enough to qualify, so a whole evening's profile showed him standing
  // for under one per cent of it — rounded, never. Standing *and staying
  // stood* is both visible and much worse: the table plays the rest of the
  // night with him on his feet at the head of it.
  if (state.roseAt !== null) return 'RISEN';
  if (!context.handInProgress && context.dread >= DEALER.riseAbove) return 'RISEN';

  // Dealing is an *event*, not a state: cards leave his hands and a second
  // later they have landed. The first version asked the match whether it was
  // mid-deal, and the match is never mid-anything — by the time a hand exists
  // the cards are already dealt — so he never once dealt in a whole match.
  // A window after the last thing that moved is what a body doing it looks
  // like.
  if (context.dealtAt !== null && context.now - context.dealtAt < DEALER.dealingMs) {
    return 'DEALING';
  }

  // Between hands and not dark enough to stand: he simply waits.
  if (!context.handInProgress) return 'STILL';

  const watchingSomebody = state.gaze.kind === 'SEAT';
  if (!watchingSomebody) return 'STILL';
  return context.dread >= DEALER.leanAbove ? 'LEANING' : 'WATCHING';
}

/**
 * Who he looks at.
 *
 * In order of preference: stay on whoever he is already watching, notice
 * somebody lifting their cards, watch whoever has to act, or pick a seat. The
 * first of those is what stops him reading as a sprinkler, and it is also the
 * one that unsettles people — he had a reason to look at you, the reason has
 * passed, and he is still looking at you.
 */
function chooseGaze(state: DealerState, context: DealerContext, rng: RandomSource): GazeTarget {
  if (context.seats.length === 0) return GAZE_AWAY;

  if (state.gaze.kind === 'SEAT' && chance(rng, DEALER.stayChance)) return state.gaze;

  // Somebody has their hand off the felt. He is allowed to notice that; it is
  // the one thing at this table everybody can see everybody else do.
  if (context.liftedSeats.length > 0 && chance(rng, DEALER.noticePeekChance)) {
    return { kind: 'SEAT', seatIndex: pick(context.liftedSeats, rng) };
  }

  if (context.actingSeat !== null) return { kind: 'SEAT', seatIndex: context.actingSeat };

  // Nothing is happening. Most of the time he watches somebody anyway.
  if (chance(rng, 0.75)) return { kind: 'SEAT', seatIndex: pick(context.seats, rng) };
  return GAZE_AWAY;
}

/**
 * Him, as everyone sees him.
 *
 * `stillMs` is computed here rather than stored, so it keeps climbing between
 * decisions without anything having to tick it.
 */
export function projectDealer(state: DealerState, now: number): DealerPresence {
  return {
    gaze: state.gaze,
    posture: state.posture,
    stillMs: Math.max(0, now - state.lastMovedAt),
    twitchAt: state.twitchAt,
  };
}

/** A weighted coin, drawn from his own source and never the deck's. */
function chance(rng: RandomSource, probability: number): boolean {
  if (probability <= 0) return false;
  if (probability >= 1) return true;
  return rng.nextInt(1000) < Math.round(probability * 1000);
}

function pick<T>(values: T[], rng: RandomSource): T {
  return values[rng.nextInt(values.length)]!;
}
