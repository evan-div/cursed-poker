import {
  DEFAULT_BLIND_STRUCTURE,
  type BlindStructure,
  type LegalActions,
  type PlayerAction,
} from '@cursed/shared';
import { SeededRandomSource } from '../poker/index.js';
import { ManualClock } from './clock.js';
import { Match, type MatchTimings } from './match.js';
import type { StressTuning } from './stress.js';
import type { StressObserver } from './stress-telemetry.js';

/**
 * A whole evening at the table, played by bots, on a fake clock.
 *
 * Shared by everything that needs to ask "what does a real match actually do?"
 * — the dread profile, the stress profile, and `npm run stress`. The bots are
 * deliberately unremarkable: mostly passive, sometimes not, and they take a few
 * seconds to think, because a match where everybody acts instantly happens in
 * a few seconds of clock time and says nothing about the real one.
 */

/** Randomised but plausible: mostly passive, sometimes not. */
export function chooseAction(legal: LegalActions, pot: number, rng: SeededRandomSource): PlayerAction {
  const roll = rng.nextInt(100);
  const size = () => {
    const low = legal.minRaiseTo;
    const high = Math.min(legal.maxRaiseTo, Math.max(low, pot + legal.callAmount * 2));
    return high <= low ? low : low + rng.nextInt(high - low + 1);
  };
  const aggressive = (): PlayerAction =>
    legal.raiseActionType === 'BET' ? { type: 'BET', to: size() } : { type: 'RAISE', to: size() };

  if (legal.canCheck) {
    if (roll < 60) return { type: 'CHECK' };
    if (roll < 95 && legal.canRaise) return aggressive();
    return { type: 'CHECK' };
  }
  if (roll < 32) return { type: 'FOLD' };
  if (roll < 82) return { type: 'CALL' };
  if (roll < 96 && legal.canRaise) return aggressive();
  if (legal.canRaise || legal.canCall) return { type: 'ALL_IN' };
  return { type: 'FOLD' };
}

/** The presence tick, exactly as `game-server.ts` runs it. */
export const SIM_STEP_MS = 83;

export const SIM_TIMINGS: MatchTimings = {
  actionTimeoutMs: 30_000,
  disconnectedActionTimeoutMs: 5_000,
  showdownDisplayMs: 4_000,
  foldedHandDisplayMs: 1_500,
  betweenHandsMs: 1_500,
};

export interface EveningOptions {
  players: number;
  seed: number;
  structure?: BlindStructure;
  stressTuning?: Partial<StressTuning>;
  telemetry?: StressObserver;
  /** Called after every tick, for whoever is measuring. */
  onTick?: (match: Match, clock: ManualClock) => void;
}

export interface Evening {
  match: Match;
  minutes: number;
  hands: number;
}

export function playEvening(options: EveningOptions): Evening {
  const { players, seed } = options;
  const clock = new ManualClock();
  const started = clock.now();
  const match = new Match({
    roomCode: 'EVENING',
    hostPlayerId: 'p0',
    clock,
    rng: new SeededRandomSource(seed),
    dealerRng: new SeededRandomSource(seed * 7 + 1),
    structure: options.structure ?? DEFAULT_BLIND_STRUCTURE,
    timings: SIM_TIMINGS,
    ...(options.stressTuning ? { stressTuning: options.stressTuning } : {}),
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
  });

  const ids = Array.from({ length: players }, (_, i) => `p${i}`);
  for (const id of ids) match.join(id, id);
  for (const id of ids) match.setReady(id, true);
  match.start('p0');

  const brain = new SeededRandomSource(seed * 31 + 5);
  let thinking = 0;
  let hands = 0;
  let lastHand = -1;
  let guard = 0;

  while (match.state.status !== 'FINISHED' && guard++ < 400_000) {
    match.tick();
    options.onTick?.(match, clock);

    const hand = match.state.table?.hand ?? null;
    if (hand && hand.handNumber !== lastHand) {
      lastHand = hand.handNumber;
      hands++;
    }

    const seat = hand?.actingSeat;
    const actor =
      seat === null || seat === undefined
        ? null
        : match.state.players.find((p) => p.seatIndex === seat)?.playerId;

    if (actor && hand) {
      // People think. Without it the whole match happens inside a few seconds
      // of clock time, and nothing that decays over seconds is ever measured.
      if (thinking > 0) {
        thinking -= SIM_STEP_MS;
        clock.advance(SIM_STEP_MS);
        continue;
      }
      const view = match.viewFor(actor);
      const legal = view.you.legalActions;
      if (!legal) {
        clock.advance(SIM_STEP_MS);
        continue;
      }
      try {
        match.submitAction(actor, hand.handNumber, chooseAction(legal, view.hand?.potTotal ?? 0, brain));
      } catch {
        match.submitAction(actor, hand.handNumber, { type: 'FOLD' });
      }
      thinking = 1_200 + (brain.nextInt(1000) / 1000) * 5_500;
    } else {
      thinking = 0;
      clock.advance(SIM_STEP_MS);
    }
  }

  return { match, minutes: (clock.now() - started) / 60_000, hands };
}
