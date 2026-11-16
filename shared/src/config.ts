/**
 * Match tuning constants.
 *
 * Anything here is balance, not rules. The poker engine reads *none* of it
 * except the blind level it is handed for a given hand.
 */

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 6;
export const SEAT_COUNT = 6;

/**
 * Lobby code alphabet, chosen to survive being read aloud: no 0/O, no 1/I/L.
 * 31^6 is about 887 million codes, which with join rate limiting is enough that
 * guessing a live lobby is not a practical attack.
 *
 * Here rather than beside the schema that validates a code, because the client
 * needs to recognise one in an invite link and must not pull the whole schema
 * library into the browser to do it.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 6;

/** Picks a lobby code out of text, or returns null. Case is forgiven. */
export function parseRoomCode(text: string): string | null {
  const candidate = text.trim().toUpperCase();
  if (candidate.length !== ROOM_CODE_LENGTH) return null;
  for (const character of candidate) {
    if (!ROOM_CODE_ALPHABET.includes(character)) return null;
  }
  return candidate;
}

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
