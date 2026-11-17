/**
 * Makes a stretch of sound loop without a seam.
 *
 * A buffer played on repeat jumps from its last sample back to its first, and
 * unless those happen to match, the jump is a click. The room tone is seven
 * seconds of noise that ends wherever it ends — so every seven seconds there
 * was a tick, in exactly the kind of rhythm the tone exists to avoid having.
 *
 * The fix is the usual one: cut the tail off and fold it into the head. The
 * loop then ends just before the piece that was cut, and begins by fading that
 * piece out under the opening — so the wrap continues the original sound
 * instead of interrupting it.
 *
 * Pure, over plain samples, so it can be checked without a sound card.
 */
export function loopSeamlessly(samples: Float32Array, fadeSamples: number): Float32Array {
  const fade = Math.max(0, Math.min(Math.floor(fadeSamples), samples.length >> 1));
  const length = samples.length - fade;
  const out = samples.slice(0, length);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    // Equal power rather than equal gain: the two halves are unrelated noise,
    // and adding them in straight proportion would dip in the middle.
    out[i] = samples[i]! * Math.sqrt(t) + samples[length + i]! * Math.sqrt(1 - t);
  }
  return out;
}
