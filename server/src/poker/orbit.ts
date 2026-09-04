/**
 * First-orbit tracking.
 *
 * The match's first supernatural ritual fires once every player has held the
 * dealer button exactly once. That is pure button bookkeeping — no horror
 * system reaches in here, and this module has no idea what the ritual is for.
 *
 * The naive rule ("orbit is over after N hands") breaks the moment the field
 * changes, so completion is defined against who is *still* in the match, with a
 * hand-count safety valve so a departure can never stall the ritual forever.
 */

export interface OrbitState {
  /** Seats dealt into hand one — the field the orbit was promised to. */
  readonly initialSeats: readonly number[];
  /** Seats that have held the button so far, in the order they held it. */
  readonly visited: readonly number[];
  readonly handsPlayed: number;
  readonly complete: boolean;
}

export function createOrbitState(initialSeats: readonly number[]): OrbitState {
  return {
    initialSeats: [...initialSeats].sort((a, b) => a - b),
    visited: [],
    handsPlayed: 0,
    complete: false,
  };
}

/**
 * Records a finished hand.
 *
 * `remainingSeats` is who is still in the match afterwards. A player who has
 * left before taking the button is no longer owed one, so they drop out of the
 * requirement rather than freezing it.
 */
export function recordHand(
  state: OrbitState,
  hand: { buttonSeat: number; remainingSeats: readonly number[] },
): OrbitState {
  if (state.complete) return state;

  const visited = state.visited.includes(hand.buttonSeat)
    ? state.visited
    : [...state.visited, hand.buttonSeat];
  const handsPlayed = state.handsPlayed + 1;

  const everyoneHasHadIt = hand.remainingSeats.every((seat) => visited.includes(seat));
  // Safety valve: the ritual can never be delayed past one hand per starting
  // seat, however the field changes.
  const ranLongEnough = handsPlayed >= state.initialSeats.length;

  return {
    ...state,
    visited,
    handsPlayed,
    complete: everyoneHasHadIt || ranLongEnough,
  };
}

/** Seats still owed the button before the orbit closes. */
export function pendingSeats(state: OrbitState, remainingSeats: readonly number[]): number[] {
  if (state.complete) return [];
  return remainingSeats.filter((seat) => !state.visited.includes(seat));
}
