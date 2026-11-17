/**
 * How much the room is allowed to cost.
 *
 * Two tiers, because there are two kinds of machine: ones where the lens work,
 * the lit air and the candles are free, and ones where they are the difference
 * between a table and a slideshow. This game is played by reading small
 * movements in other people's hands; a frame rate that hides them is a worse
 * failure than a room without bloom.
 *
 * Nobody is asked to choose. The scene starts on `high` and `Governor` watches
 * how long frames actually take; a machine that cannot keep up is moved to
 * `low` once, quietly, and stays there. A player who knows better can pin
 * either tier with `?quality=low` or `?quality=high` in the address, which also
 * turns the governor off — that is what the screenshot scripts do, since a
 * software renderer would otherwise always be demoted.
 */

export type Detail = 'high' | 'low';

const STORAGE_KEY = 'cursed-poker.quality';

/** The tier somebody asked for by name, if anybody did. */
export function pinnedDetail(
  search: string = typeof location === 'undefined' ? '' : location.search,
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
): Detail | null {
  const asked = new URLSearchParams(search).get('quality') ?? storage?.getItem(STORAGE_KEY) ?? null;
  return asked === 'high' || asked === 'low' ? asked : null;
}

/** Tuning for the governor. Feel, not rules. */
export const GOVERNOR = {
  /** Frames at the start that do not count: shaders compiling, textures uploading. */
  warmupFrames: 90,
  /** A frame slower than this is a slow frame: under thirty a second. */
  slowFrameMs: 34,
  /** This long spent mostly on slow frames, and the room is too expensive. */
  patienceMs: 2_500,
  /** How quickly the running average follows the frames, per frame. */
  smoothing: 0.08,
} as const;

/**
 * Decides when a machine is not keeping up.
 *
 * Pure, and fed frame times rather than reading a clock, so "does a slow
 * machine get demoted, and does a fast one with one bad second not?" is a
 * question with a test.
 */
export class Governor {
  #frames = 0;
  #average = 0;
  #slowFor = 0;
  #done = false;

  /**
   * Hears how long the last frame took. Returns true, once, when the scene
   * should drop to `low`.
   */
  frame(milliseconds: number): boolean {
    if (this.#done) return false;
    this.#frames++;
    if (this.#frames <= GOVERNOR.warmupFrames) return false;

    // A tab that was hidden comes back with one enormous frame. That is not
    // the machine being slow.
    const frame = Math.min(milliseconds, 250);
    this.#average = this.#average === 0 ? frame : this.#average + (frame - this.#average) * GOVERNOR.smoothing;

    if (this.#average > GOVERNOR.slowFrameMs) this.#slowFor += frame;
    else this.#slowFor = Math.max(0, this.#slowFor - frame * 2);

    if (this.#slowFor < GOVERNOR.patienceMs) return false;
    this.#done = true;
    return true;
  }

  /** The running average frame time, in milliseconds. Zero during warm-up. */
  get averageMs(): number {
    return this.#average;
  }
}
