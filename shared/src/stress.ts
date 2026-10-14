/**
 * Stress, and what it shows.
 *
 * ---
 *
 * ## The rule this entire phase turns on
 *
 * **Stress may not read a card.** Not a hole card, not a hand ranking, not an
 * equity, not a draw. Nothing in `StressInput` or `StressEvent` carries one, and
 * `stress-boundary.test.ts` plays two tables through identical public actions
 * over completely different decks and requires every heart rate to match.
 *
 * The reason is not fastidiousness. Tremor is *broadcast*: every seat's shake is
 * on every screen at the table. If stress rose with hand strength, that shake
 * would be a public readout of a private fact — a decoder for hole cards, opened
 * by the server, available to anybody who learned to read it. It would be
 * strictly more information than poker gives you, which makes it strictly worse
 * than cheating: it would be *the rules*.
 *
 * So stress is driven by what is happening **to** a player, never by what they
 * **hold**:
 *
 *   - how many chips are in front of them and how many are at risk
 *   - how short they are, how close the clock is, how high the blinds have got
 *   - who just went out, and how bad the room has become
 *   - **what they themselves have been doing** — how often they have re-checked
 *     their cards, how long they have stared at them, how long they sat still
 *
 * That last group is the one that makes the whole thing work. Those are already
 * public: lift and stillness have been replicated since Phase 4. So a tell does
 * not leak anything new — it *amplifies* what the table could already have seen
 * if anybody had been watching. And it means the tell can be managed, which is
 * what Phase 7 is for. A tell you cannot do anything about is a readout; a tell
 * that follows your own behaviour is a skill.
 *
 * The cost is honest and worth stating: a player holding aces trembles no more
 * than a player holding seven-deuce in the same spot. That is correct. What
 * differs between them is what they *do* — and what they do is public already.
 */

/**
 * The things that happen to a player, by name.
 *
 * Named rather than numeric so the model is legible in a log and in a replay:
 * "FACED_ALL_IN at hand 41" says something a weight of 0.6 never will. Every
 * one of them is a public occurrence — see the rule above.
 */
export const STRESS_EVENTS = [
  /** Cards are in the air. A small lift for everybody dealt in. */
  'DEALT_IN',
  /** It is your turn and there is money to call. */
  'FACED_BET',
  /** It is your turn and the money is all of somebody's. */
  'FACED_ALL_IN',
  /** You have just put a real part of your stack in. */
  'COMMITTED',
  /** You pushed the lot. */
  'SHOVED',
  /** You are about to be put to the test by a clock. */
  'CLOCK_LOW',
  /** The blinds went up on everybody. */
  'BLINDS_UP',
  /** A chair at this table emptied. */
  'SEAT_EMPTIED',
  /** You lost a pot you had committed to. */
  'LOST_POT',
  /** You won one. Relief is not calm; it spikes too, and then it falls faster. */
  'WON_POT',
  /** You looked at your own cards again. Everyone saw you do it. */
  'RE_CHECKED',
  /** The Dealer's head is pointed at you. */
  'WATCHED',
] as const;
export type StressEvent = (typeof STRESS_EVENTS)[number];

/**
 * What each one does to a heart, and how fast it fades.
 *
 * `spike` is added to a 0..1 stress scalar; `relief` scales how fast that
 * particular contribution decays afterwards. Winning a pot spikes nearly as hard
 * as losing one and then drops away, which is what relief actually feels like.
 */
export const STRESS_WEIGHTS: Record<StressEvent, { spike: number; relief: number }> = {
  DEALT_IN: { spike: 0.04, relief: 1 },
  FACED_BET: { spike: 0.12, relief: 1 },
  FACED_ALL_IN: { spike: 0.3, relief: 0.7 },
  COMMITTED: { spike: 0.16, relief: 0.9 },
  SHOVED: { spike: 0.34, relief: 0.6 },
  CLOCK_LOW: { spike: 0.22, relief: 1.4 },
  BLINDS_UP: { spike: 0.06, relief: 1.2 },
  SEAT_EMPTIED: { spike: 0.14, relief: 0.8 },
  LOST_POT: { spike: 0.26, relief: 0.75 },
  WON_POT: { spike: 0.2, relief: 2.2 },
  RE_CHECKED: { spike: 0.07, relief: 1.3 },
  WATCHED: { spike: 0.1, relief: 1 },
};

export const STRESS = {
  /** How long a spike takes to fall to a third of itself, in milliseconds. */
  halfLifeMs: 9_000,
  /** Resting and flat-out heart rate, in beats per minute. */
  restingBpm: 62,
  maxBpm: 155,
  /**
   * How far the standing pressures can push stress on their own.
   *
   * A floor rather than a spike: being down to four big blinds is not an event,
   * it is a condition, and it does not decay because it has not stopped.
   */
  floorWeight: 0.55,
  /** Stack, in big blinds, at or below which the short-stack floor is full. */
  desperateBlinds: 6,
  /** Stack, in big blinds, above which it contributes nothing. */
  comfortableBlinds: 40,
  /**
   * Steps the broadcast tells are rounded to.
   *
   * The same reasoning that quantises gaze, for a sharper reason. A tremor
   * streamed at full precision could be differenced frame to frame by a script
   * and turned into a far better read than any human eye could make — and
   * because stress is partly driven by a player's own public behaviour, a
   * high-resolution tremor is close to a transcript of it. Eight steps is
   * plenty to see somebody shaking and nowhere near enough to decode them.
   */
  tellSteps: 8,
} as const;

/** How visibly somebody is sweating. Three words, because eyes are not meters. */
export const SWEAT_LEVELS = ['DRY', 'DAMP', 'SOAKED'] as const;
export type SweatLevel = (typeof SWEAT_LEVELS)[number];

/**
 * One seat's tells, as everybody at the table sees them.
 *
 * Note what is absent, again, and permanently: no heart rate, no stress scalar,
 * no hand strength, no card. A heart rate is a number; a tell is a thing you
 * notice. Broadcasting the number would make reading people arithmetic.
 */
export interface SeatTells {
  /** How much their hands are shaking, 0..1, quantised. */
  tremor: number;
  /** How hard they are breathing, 0..1, quantised. */
  breathing: number;
  sweat: SweatLevel;
}

/** A seat showing nothing at all. */
export const CALM: SeatTells = { tremor: 0, breathing: 0, sweat: 'DRY' };

/**
 * What a player is told about their own body.
 *
 * Owner-only, and the only place a real number appears. You get to know your own
 * heart rate because you can feel it; nobody else does, because they cannot.
 */
export interface SelfStress {
  /** Beats per minute. */
  heartRate: number;
  /** The scalar behind it, 0..1, so the client can drive its own feedback. */
  stress: number;
}

export const COMPOSED: SelfStress = { heartRate: STRESS.restingBpm, stress: 0 };

/** Rounds a tell to the resolution everybody receives it at. */
export function quantiseTell(value: number): number {
  const clamped = Math.min(Math.max(value, 0), 1);
  return Math.round(clamped * STRESS.tellSteps) / STRESS.tellSteps;
}

/** A heart rate for a stress level. Linear; a heart is not subtle about this. */
export function heartRateFor(stress: number): number {
  const s = Math.min(Math.max(stress, 0), 1);
  return Math.round(STRESS.restingBpm + (STRESS.maxBpm - STRESS.restingBpm) * s);
}

/**
 * The tells a stress level produces.
 *
 * The three do not arrive together, which is most of what makes them readable
 * as a progression rather than as one bar drawn three ways. Breathing goes
 * first and goes early — it is the one thing a calm-looking player is still
 * doing. Hands start shaking later and harder. Sweat is last and coarsest.
 */
export function tellsFor(stress: number): SeatTells {
  const s = Math.min(Math.max(stress, 0), 1);
  return {
    // Shaking starts late, then climbs fast.
    tremor: quantiseTell(s < 0.35 ? 0 : (s - 0.35) / 0.65),
    // Breathing is already moving while somebody still looks composed.
    breathing: quantiseTell(Math.min(1, s * 1.35)),
    sweat: s > 0.78 ? 'SOAKED' : s > 0.5 ? 'DAMP' : 'DRY',
  };
}
