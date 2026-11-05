/**
 * Tunnel vision: the edges of the room going dark when you are frightened.
 *
 * A DOM layer rather than a post-processing pass, for two reasons. It costs
 * nothing — a transform is composited, not painted, so a vignette that throbs
 * with your pulse sixty times a second never touches the GPU's render of the
 * table. And it has a *place in the stack*: above the 3D scene,
 * below the nameplates and the HUD.
 *
 * That placement is the rule. Fear is allowed to make the room harder to
 * watch — that is what it is for, and it follows only your own stress, which
 * the server built from public facts. It is never allowed to hide a stack, an
 * action, a timer or a button. Those are poker, and poker is not affected.
 */
/** The layer's scale with the edges fully open, and fully closed in. */
const TUNNEL_SCALE = { open: 2.2, closed: 0.92 } as const;

export class Tunnel {
  readonly root: HTMLElement;
  #shown = -1;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'tunnel';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.style.visibility = 'hidden';
  }

  /** How far the edges have closed in, 0..1. Cheap to call every frame. */
  set(amount: number): void {
    const a = Math.min(Math.max(Number.isFinite(amount) ? amount : 0, 0), 1);
    if (Math.abs(a - this.#shown) < 0.002) return;
    this.#shown = a;
    if (a === 0) {
      this.root.style.visibility = 'hidden';
      return;
    }
    this.root.style.visibility = 'visible';
    // How bad it is is how far the rim has come in, not how dark it is. At
    // the onset the layer is scaled far past the screen and only the corners
    // catch the dark; at full panic it is barely larger than the screen and
    // the rim sits on all four edges. Oversized enough (see `.tunnel` in the
    // stylesheet) to cover the screen at the smallest scale used here.
    //
    // Scale rather than opacity: a gradient layer at partial opacity all but
    // vanished under software compositing, and only transform is guaranteed
    // to stay on the compositor everywhere.
    this.root.style.transform = `scale(${(TUNNEL_SCALE.open - (TUNNEL_SCALE.open - TUNNEL_SCALE.closed) * a).toFixed(4)})`;
  }
}
