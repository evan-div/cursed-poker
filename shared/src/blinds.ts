/**
 * Blind structure.
 *
 * Match pacing is a *data* problem, never a poker-logic problem. The engine
 * receives whatever `BlindLevel` the match controller hands it and has no
 * opinion about escalation. Tuning the 60-90 minute target means editing this
 * file and nothing else.
 *
 * Antes use the modern big-blind-ante convention: the big blind posts a single
 * ante on behalf of the table. For a short stack the ante is posted first and
 * the blind comes out of whatever remains (TDA convention), so a player can be
 * all-in for less than a full blind.
 */

export interface BlindLevel {
  /** 1-based level number, for display. */
  level: number;
  smallBlind: number;
  bigBlind: number;
  /** Big-blind ante. 0 disables antes for the level. */
  ante: number;
  /** How long the level lasts before the next one begins. */
  durationSeconds: number;
}

export interface BlindStructure {
  id: string;
  label: string;
  levels: readonly BlindLevel[];
  /** Starting stack expressed in big blinds of level 1. */
  startingStackBigBlinds: number;
}

const L = (
  level: number,
  smallBlind: number,
  bigBlind: number,
  ante: number,
  durationSeconds: number,
): BlindLevel => ({ level, smallBlind, bigBlind, ante, durationSeconds });

const EIGHT_MINUTES = 8 * 60;
const SIX_MINUTES = 6 * 60;

/**
 * Default structure, targeting a 60-90 minute match for 4-6 players.
 *
 * Level 1 is 50/100 and the starting stack is 100BB = 10,000 chips.
 *
 * Reference pacing with six players (60,000 chips in play, ignoring sacrifice
 * rebuys) — average stack measured in big blinds:
 *
 *   L1 100BB   L4  33BB   L7 12.5BB   L10 4.2BB
 *   L2  67BB   L5  25BB   L8  8.3BB   L11 2.8BB
 *   L3  50BB   L6  17BB   L9  6.3BB
 *
 * L8 lands at the 64 minute mark; sacrifice rebuys push a full-length match
 * toward the top of the window rather than past it, which is the intent.
 * Levels shorten to six minutes from L9 so a stalled match still terminates.
 */
export const DEFAULT_BLIND_STRUCTURE: BlindStructure = {
  id: 'default-60-90',
  label: 'Standard Seance (60-90 min)',
  startingStackBigBlinds: 100,
  levels: [
    L(1, 50, 100, 0, EIGHT_MINUTES),
    L(2, 75, 150, 0, EIGHT_MINUTES),
    L(3, 100, 200, 0, EIGHT_MINUTES),
    L(4, 150, 300, 0, EIGHT_MINUTES),
    L(5, 200, 400, 400, EIGHT_MINUTES),
    L(6, 300, 600, 600, EIGHT_MINUTES),
    L(7, 400, 800, 800, EIGHT_MINUTES),
    L(8, 600, 1_200, 1_200, EIGHT_MINUTES),
    L(9, 800, 1_600, 1_600, SIX_MINUTES),
    L(10, 1_200, 2_400, 2_400, SIX_MINUTES),
    L(11, 1_500, 3_000, 3_000, SIX_MINUTES),
    L(12, 2_000, 4_000, 4_000, SIX_MINUTES),
    L(13, 3_000, 6_000, 6_000, SIX_MINUTES),
    L(14, 4_000, 8_000, 8_000, SIX_MINUTES),
    L(15, 6_000, 12_000, 12_000, SIX_MINUTES),
  ],
};

/** Compressed structure for automated simulations and local playtesting. */
export const TURBO_BLIND_STRUCTURE: BlindStructure = {
  id: 'turbo-test',
  label: 'Turbo (testing)',
  startingStackBigBlinds: 100,
  levels: DEFAULT_BLIND_STRUCTURE.levels.map((lvl) => ({ ...lvl, durationSeconds: 60 })),
};

export function startingStackFor(structure: BlindStructure): number {
  const first = structure.levels[0];
  if (!first) throw new Error(`Blind structure "${structure.id}" has no levels`);
  return first.bigBlind * structure.startingStackBigBlinds;
}

/**
 * The level index for a given elapsed match time. Clamps to the final level so
 * a long match freezes at the steepest blinds rather than running out of data.
 */
export function levelIndexForElapsed(structure: BlindStructure, elapsedSeconds: number): number {
  let remaining = Math.max(0, elapsedSeconds);
  for (let i = 0; i < structure.levels.length; i++) {
    const level = structure.levels[i]!;
    if (remaining < level.durationSeconds) return i;
    remaining -= level.durationSeconds;
  }
  return structure.levels.length - 1;
}

export function levelAt(structure: BlindStructure, index: number): BlindLevel {
  const clamped = Math.min(Math.max(index, 0), structure.levels.length - 1);
  const level = structure.levels[clamped];
  if (!level) throw new Error(`Blind structure "${structure.id}" has no levels`);
  return level;
}
