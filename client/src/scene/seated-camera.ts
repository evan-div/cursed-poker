import { PerspectiveCamera, Vector3 } from 'three';
import type { GazeTarget } from '@cursed/shared';
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

  #seatIndex: number | null = null;
  #seats: readonly number[] = [];
  #gaze: GazeTarget = { kind: 'AWAY' };
  #forward = new Vector3();

  #dragging = false;
  #locked = false;
  #lastX = 0;
  #lastY = 0;
  #element: HTMLElement | null = null;
  #detach: (() => void) | null = null;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(58, aspect, 0.02, 40);
  }

  /** Moves to a seat. Passing null seats the viewer in the Dealer's place. */
  sitAt(seatIndex: number | null): void {
    const seat = seatedView(seatIndex);
    this.camera.position.set(seat.position.x, seat.position.y, seat.position.z);
    this.#baseYaw = seat.yaw;
    this.#seatIndex = seatIndex;
    this.attention.clear();
    this.#applyRotation();
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
    document.addEventListener('pointerlockchange', lockChanged);
    element.style.touchAction = 'none';

    this.#detach = () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
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
    // Bias moves the *target*, not the camera, so a player who takes over
    // mid-drift continues from where their head already was.
    const drift = this.attention.step(this.#targetYaw, this.#targetPitch, delta, now);
    if (drift.yaw !== 0 || drift.pitch !== 0) {
      this.#targetYaw = clamp(this.#targetYaw + drift.yaw, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw);
      this.#targetPitch = clamp(
        this.#targetPitch + drift.pitch,
        LOOK_LIMITS.pitchDown,
        LOOK_LIMITS.pitchUp,
      );
    }

    const ease = 1 - Math.exp(-14 * delta);
    this.#yaw += (this.#targetYaw - this.#yaw) * ease;
    this.#pitch += (this.#targetPitch - this.#pitch) * ease;
    this.#applyRotation();
    this.#updateGaze();
  }

  /**
   * Points the head at a world position, softly.
   *
   * The camera's yaw convention is the opposite sign to a body's, so this is the
   * one place that conversion is done — see `layout.ts`.
   */
  focusOn(at: Vec3, weight: number, now = performance.now(), durationMs?: number): void {
    const dx = at.x - this.camera.position.x;
    const dz = at.z - this.camera.position.z;
    const dy = at.y - this.camera.position.y;

    const worldYaw = Math.atan2(-dx, -dz);
    const yaw = clamp(worldYaw - this.#baseYaw, -LOOK_LIMITS.yaw, LOOK_LIMITS.yaw);
    const pitch = clamp(
      Math.atan2(dy, Math.hypot(dx, dz)),
      LOOK_LIMITS.pitchDown,
      LOOK_LIMITS.pitchUp,
    );

    this.attention.focus(yaw, pitch, weight, now, durationMs);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  #updateGaze(): void {
    this.camera.getWorldDirection(this.#forward);
    const target = resolveGaze(this.eye, this.#forward, this.#seatIndex, this.#seats);
    const same =
      target.kind === this.#gaze.kind &&
      (target.kind !== 'SEAT' ||
        (this.#gaze.kind === 'SEAT' && target.seatIndex === this.#gaze.seatIndex));
    if (same) return;
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
