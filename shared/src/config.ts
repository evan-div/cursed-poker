/**
 * Match tuning constants.
 *
 * Anything here is balance, not rules. The poker engine reads *none* of it
 * except the blind level it is handed for a given hand.
 */

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 6;
export const SEAT_COUNT = 6;

export interface SacrificeConfig {
  /** How many sacrifices a player gets for the whole match. */
  maxSacrifices: number;
  /**
   * Chips granted per sacrifice, expressed in big blinds of the *current*
   * level so the mechanic stays relevant as blinds escalate. Prototype value;
   * needs playtesting against the blind structure before it is locked.
   */
  rebuyBigBlinds: number;
  /**
   * A player may *voluntarily* sacrifice only while their stack is strictly
   * below this many big blinds. Busted players may always sacrifice.
   */
  voluntaryThresholdBigBlinds: number;
}

export const DEFAULT_SACRIFICE_CONFIG: SacrificeConfig = {
  maxSacrifices: 3,
  rebuyBigBlinds: 25,
  voluntaryThresholdBigBlinds: 20,
};

export interface PerkConfig {
  /** Perk options offered to each player at the ritual. */
  choicesPerPlayer: number;
}

export const DEFAULT_PERK_CONFIG: PerkConfig = {
  choicesPerPlayer: 3,
};

/** Sacrifice rituals, in the fixed order they are spent. */
export const SACRIFICE_ORDER = ['PALM_SLICE', 'FINGER_REMOVAL', 'TOOTH_EXTRACTION'] as const;
export type SacrificeKind = (typeof SACRIFICE_ORDER)[number];
