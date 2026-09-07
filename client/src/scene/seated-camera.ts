import { PerspectiveCamera, Vector3 } from 'three';
import { LEAN, gazeEquals, type GazeTarget } from '@cursed/shared';
import { AttentionDirector } from './attention.js';
import { resolveGaze } from './gaze.js';
import { LOOK_LIMITS, REST_PITCH, clamp, seatedView, type Vec3 } from './layout.js';

/**
 * A seated first-person camera.
 *
 * The player is in a chair, not on rails and not floating: the camera sits at
 * their seat and they turn their head. Yaw and pitch are clamped to what a
 * person could manage without standing up, which does more for the feeling of
 * being stuck at this table than any amount of geometry.
 *
 * Two things arrived in Phase 4.
 *
 * **Pointer lock**, which was deferred in Phase 3 because it fights a DOM action
 * bar. The resolution is that it is *offered*, not imposed: clicking the table
 * takes the pointer, Escape gives it back, and the action bar has keyboard
 * bindings so a locked player never has to break out to bet. Dragging still
 * works unlocked, for a trackpad, a touch screen, or anyone who dislikes it.
 *
 * **Attention bias.** When something happens, the head drifts toward it. The
 * bias moves the player's own look target rather than overriding it, so taking
 * over mid-drift is seamless — and moving the mouse at all cancels it outright.
 * See `attention.ts` for why that surrender is the important half.
 */
/**
 * How long a look must hold before the table is told about it.
 *
 * Long enough that glancing past somebody is not reported, short enough that
 * deliberately checking an opponent still registers well inside the time it
 * takes them to act.
 */
export const GAZE_DWELL_MS = 220;

export class SeatedCamera {
  readonly camera: PerspectiveCamera;
  readonly attention = new AttentionDirector();

  /** Called when the player looks at something different. */
  onGazeChanged: ((target: GazeTarget) => void) | null = null;
  /** Called when pointer lock is gained or lost, for the HUD hint. */
  onLockChanged: ((locked: boolean) => void) | null = null;
  /**
   * Called with pointer movement while the peek gesture has the pointer.
   *
   * Lifting a card and turning your head are the same physical input, so
   * something has to arbitrate. The peek wins while it is held, which is why
   * this hook exists rather than the camera reading the gesture directly.
   */
  onPointerConsumed: ((dx: number, dy: number) => void) | null = null;
  /** Asked before each pointer movement: is something else using the pointer? */
  pointerIsConsumed: (() => boolean) | null = null;

  #baseYaw = 0;
  #yaw = 0;
  // A seated player's resting gaze is on the felt, not level with the far wall.
  #pitch = REST_PITCH;
  #targetYaw = 0;
  #targetPitch = REST_PITCH;

  #seat = { x: 0, y: 0, z: 0 };
  #lean = 0;
  #peekLean = 0;
  #shownLean = -1;
  #leanFov = -1;
  #leanYaw = 0;
  #leanPitch = 0;
  #aspect: number;
  #seatIndex: number | null = null;
  #seats: readonly number[] = [];
  #gaze: GazeTarget = { kind: 'AWAY' };
  #candidate: GazeTarget = { kind: 'AWAY' };
  #candidateSince = 0;
  #forward = new Vector3();

  #dragging = false;
  #locked = false;
  #lastX = 0;
  #lastY = 0;
  #element: HTMLElement | null = null;
  #detach: (() => void) | null = null;

  constructor(aspect: number) {
    this.#aspect = aspect;
    this.camera = new PerspectiveCamera(LEAN.restFov, aspect, 0.02, 40);
  }

  /** Moves to a seat. Passing null seats the viewer in the Dealer's place. */
  sitAt(seatIndex: number | null): void {
    const seat = seatedView(seatIndex);
    this.#seat = { ...seat.position };
    this.#baseYaw = seat.yaw;
    this.#seatIndex = seatIndex;
    this.#lean = 0;
    this.#peekLean = 0;
    // Forces the move to actually happen. `#applyLean` skips its work when the
    // lean has not changed, which is right every frame and catastrophic here:
    // sitting down at a new seat with the same posture left the camera at the
    // old one, facing the new one's direction. You looked out of your own head
    // from somebody else's chair.
    this.#shownLean = -1;
    this.attention.clear();
    this.#applyLean();
    this.#applyRotation();
  }

  /**
   * How far the player is leaning over the table, 0..1.
   *
   * Public because it is replicated: leaning in to study the board is something
   * the rest of the room can see you do, which is the whole reason this is a
   * lean rather than a camera zoom.
   */
  /**
   * The posture the *player* chose, which is what the table is told about.
   *
   * Not the same as how far the camera has actually come forward: lifting a
   * card brings your head down to it as well, and that movement is already
   * reported as a peek. Replicating it twice would show the table somebody
   * hunching over nothing.
   */
  get lean(): number {
    return this.#lean;
  }

  /** Sets the posture directly. The wheel is the player-facing way in. */
  leanTo(amount: number): void {
    this.#lean = clamp(amount, 0, 1);
    this.#applyLean();
  }

  /**
   * Brings the head down to a card as it is lifted.
   *
   * Nobody peels a card and then reads it from where they were sitting; they
   * bend toward it, which is most of how a corner index becomes legible across
   * half a metre of dark table. Not quite the full lean — you are looking at
   * your own hand, not trying to climb onto the felt.
   *
   * It moves the head and deliberately does *not* narrow the view. Zoom is for
   * the thing you chose to squint at; a narrower frustum while bending over
   * your own cards just crops them out of the bottom of the screen, which is
   * the opposite of the point.
   */
  setPeekLean(exposure: number): void {
    this.#peekLean = clamp(exposure, 0, 1) * 0.8;
    this.#applyLean();
  }

  /** Aims the head directly, without easing. Dragging is the way in for players. */
  lookAt(yaw: number, pitch: number): void {
    this.#targetYaw = clamp(yaw, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw);
    this.#targetPitch = clamp(pitch, LOOK_LIMITS.pitchDown, LOOK_LIMITS.pitchUp);
    this.#yaw = this.#targetYaw;
    this.#pitch = this.#targetPitch;
    this.#applyRotation();
    this.#applyLean();
  }

  /** The seats currently occupied, so a look can land on one. */
  setSeats(seats: readonly number[]): void {
    this.#seats = [...seats];
  }

  get locked(): boolean {
    return this.#locked;
  }

  get gaze(): GazeTarget {
    return this.#gaze;
  }

  /** Where the camera is, in world space. */
  get eye(): Vec3 {
    return { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z };
  }

  /**
   * Asks the browser for the pointer.
   *
   * Must be called from a user gesture. Failure is silent and harmless: dragging
   * still works, which is the whole reason both exist.
   */
  requestLock(): void {
    void this.#element?.requestPointerLock?.();
  }

  releaseLock(): void {
    if (this.#locked) document.exitPointerLock?.();
  }

  attach(element: HTMLElement): void {
    this.#element = element;

    const look = (dx: number, dy: number) => {
      if (this.pointerIsConsumed?.()) {
        this.onPointerConsumed?.(dx, dy);
        // Peeking is deliberate input too. Without this the game kept pulling
        // your head toward whoever was acting *while you were bent over your
        // own cards*, and you could not fight it, because the gesture had taken
        // the pointer you would have fought it with.
        this.attention.interrupt(Math.hypot(dx, dy), performance.now());
        return;
      }
      const speed = 0.0032;
      this.#targetYaw = clamp(this.#targetYaw - dx * speed, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw);
      this.#targetPitch = clamp(
        this.#targetPitch - dy * speed,
        LOOK_LIMITS.pitchDown,
        LOOK_LIMITS.pitchUp,
      );
      // Looking somewhere on purpose ends any bias the game was applying.
      this.attention.interrupt(Math.hypot(dx, dy), performance.now());
    };

    const down = (event: PointerEvent) => {
      // Every button, not just the left one: the peek gesture is held on the
      // right button and needs the same movement stream. Without this, lifting
      // a card unlocked produced no movement at all, because the camera was the
      // only thing tracking the pointer and it only tracked its own drag.
      this.#lastX = event.clientX;
      this.#lastY = event.clientY;
      if (!this.#locked) element.setPointerCapture(event.pointerId);
      if (event.button === 0 && !this.#locked) this.#dragging = true;
    };
    const move = (event: PointerEvent) => {
      if (this.#locked) return look(event.movementX, event.movementY);

      const dx = event.clientX - this.#lastX;
      const dy = event.clientY - this.#lastY;
      this.#lastX = event.clientX;
      this.#lastY = event.clientY;
      // Movement counts while dragging, or while something else — the peek —
      // has taken the pointer. `look` routes it onward either way.
      if (this.#dragging || this.pointerIsConsumed?.()) look(dx, dy);
    };
    const up = (event: PointerEvent) => {
      if (event.button === 0) this.#dragging = false;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    };
    // The wheel leans in over the table, and back out again. A posture rather
    // than a spring: it stays where it is put, because a player who spends the
    // whole hand hunched over the felt is telling the table something, and one
    // who has to keep scrolling to stay there is just fighting the controls.
    //
    // Deliberately not the same wheel as the action bar's bet sizing: that one
    // lives on the slider and stops the event before it reaches here.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      this.leanTo(this.#lean - event.deltaY / LEAN.travelPixels);
    };
    const lockChanged = () => {
      const locked = document.pointerLockElement === element;
      if (locked === this.#locked) return;
      this.#locked = locked;
      this.#dragging = false;
      this.onLockChanged?.(locked);
    };

    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('wheel', wheel, { passive: false });
    document.addEventListener('pointerlockchange', lockChanged);
    element.style.touchAction = 'none';

    this.#detach = () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      element.removeEventListener('wheel', wheel);
      document.removeEventListener('pointerlockchange', lockChanged);
      if (document.pointerLockElement === element) document.exitPointerLock?.();
    };
  }

  detach(): void {
    this.#detach?.();
    this.#detach = null;
    this.#element = null;
  }

  /** Eases toward where the player is looking, so the head has some weight. */
  update(delta: number, now = performance.now()): void {
    // Nothing pulls at a player who is busy with their own hands. Holding a
    // card up is a commitment; the room can wait.
    if (this.pointerIsConsumed?.()) this.attention.clear();

    // Bias moves the *target*, not the camera, so a player who takes over
    // mid-drift continues from where their head already was. Yaw only: see
    // `attention.ts` for why a pitch component walks the view off the table.
    const drift = this.attention.step(this.#targetYaw, delta, now);
    if (drift !== 0) {
      this.#targetYaw = clamp(this.#targetYaw + drift, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw);
    }

    const ease = 1 - Math.exp(-14 * delta);
    this.#yaw += (this.#targetYaw - this.#yaw) * ease;
    this.#pitch += (this.#targetPitch - this.#pitch) * ease;
    this.#applyRotation();
    this.#applyLean();
    this.#updateGaze(now);
  }

  /**
   * Turns the head toward a world position, softly.
   *
   * Only the direction is used, not the height — the bias turns a head, it does
   * not lift a chin. The camera's yaw convention is the opposite sign to a
   * body's, so this is the one place that conversion is done; see `layout.ts`.
   */
  focusOn(at: Vec3, weight: number, now = performance.now(), durationMs?: number): void {
    const dx = at.x - this.camera.position.x;
    const dz = at.z - this.camera.position.z;

    const worldYaw = Math.atan2(-dx, -dz);
    const yaw = clamp(worldYaw - this.#baseYaw, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw);

    this.attention.focus(yaw, weight, now, durationMs);
  }

  setAspect(aspect: number): void {
    this.#aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Moves the head over the table and narrows the view.
   *
   * Both together, because either alone is wrong: narrowing the field of view
   * on its own is a telescope, and moving without it is a face pressed into the
   * felt. Together they read as a person craning to see the board — which is
   * what the animation on everybody else's screen shows them doing.
   */
  #applyLean(): void {
    // Whichever is further: you cannot be sitting back and bent over a card.
    const lean = Math.max(this.#lean, this.#peekLean);
    if (
      lean === this.#shownLean &&
      this.#leanFov === this.#lean &&
      this.#leanYaw === this.#yaw &&
      this.#leanPitch === this.#pitch
    ) {
      return;
    }
    this.#shownLean = lean;
    this.#leanFov = this.#lean;
    this.#leanYaw = this.#yaw;
    this.#leanPitch = this.#pitch;

    // Straight along the line of sight, pitch included.
    //
    // Two wrong versions came before this one. Leaning toward the middle of the
    // table pushed your head over the top of your own hand when you tried to
    // read it; leaning along the horizontal heading did the same thing more
    // slowly. Following the whole look means the lean magnifies exactly what
    // you were already looking at — the board, an opponent's hands, or the two
    // cards in front of you, which you approach by going *down*.
    const heading = this.#baseYaw + this.#yaw;
    const reach = LEAN.reach * lean;
    const level = Math.cos(this.#pitch);

    this.camera.position.set(
      this.#seat.x - Math.sin(heading) * level * reach,
      this.#seat.y + Math.sin(this.#pitch) * reach,
      this.#seat.z - Math.cos(heading) * level * reach,
    );
    // Only a *chosen* lean zooms. See `setPeekLean`.
    this.camera.fov = LEAN.restFov + (LEAN.closeFov - LEAN.restFov) * this.#lean;
    this.camera.aspect = this.#aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Commits a gaze only once the player has settled on it.
   *
   * Gaze is replicated as a subject rather than an angle, so a smooth sweep of
   * the head across the table arrives at the other clients as a sequence of
   * snaps — seat 3, away, seat 4, the board, seat 5 — and every one of them
   * yanks an avatar's head to a new point. Sweeping your eyes across the room
   * made you look, to everybody else, like you were shaking your head violently.
   *
   * The fix is at the source rather than in the animation: passing your eyes
   * over somebody on the way to somebody else is not looking at them, so it is
   * not reported. Only a target held for `GAZE_DWELL_MS` is.
   *
   * This makes the signal better as well as smoother. A head that snaps to
   * everything carries no information; a head that settles carries all of it.
   */
  #updateGaze(now: number): void {
    this.camera.getWorldDirection(this.#forward);
    const target = resolveGaze(this.eye, this.#forward, this.#seatIndex, this.#seats);

    if (!gazeEquals(target, this.#candidate)) {
      this.#candidate = target;
      this.#candidateSince = now;
      return;
    }
    if (gazeEquals(target, this.#gaze)) return;
    if (now - this.#candidateSince < GAZE_DWELL_MS) return;

    this.#gaze = target;
    this.onGazeChanged?.(target);
  }

  #applyRotation(): void {
    // YXZ keeps yaw about the world axis and pitch about the head's own, which
    // is what a neck does. The default XYZ order rolls the horizon.
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.#baseYaw + this.#yaw;
    this.camera.rotation.x = this.#pitch;
    this.camera.rotation.z = 0;
  }
}
