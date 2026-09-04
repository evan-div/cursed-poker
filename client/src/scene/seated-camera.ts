import { PerspectiveCamera } from 'three';
import { LOOK_LIMITS, REST_PITCH, clamp, seatedView } from './layout.js';

/**
 * A seated first-person camera.
 *
 * The player is in a chair, not on rails and not floating: the camera sits at
 * their seat and they turn their head. Yaw and pitch are clamped to what a
 * person could manage without standing up, which does more for the feeling of
 * being stuck at this table than any amount of geometry.
 *
 * Look is on drag rather than pointer lock for now. Pointer lock is the better
 * feel and Phase 4 should revisit it, but it fights a DOM action bar, and a
 * table you cannot bet at is not worth looking around.
 */
export class SeatedCamera {
  readonly camera: PerspectiveCamera;

  #baseYaw = 0;
  #yaw = 0;
  // A seated player's resting gaze is on the felt, not level with the far wall.
  #pitch = REST_PITCH;
  #targetYaw = 0;
  #targetPitch = REST_PITCH;

  #dragging = false;
  #lastX = 0;
  #lastY = 0;
  #detach: (() => void) | null = null;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(58, aspect, 0.02, 40);
  }

  /** Moves to a seat. Passing null seats the viewer in the Dealer's place. */
  sitAt(seatIndex: number | null): void {
    const seat = seatedView(seatIndex);
    this.camera.position.set(seat.position.x, seat.position.y, seat.position.z);
    this.#baseYaw = seat.yaw;
    this.#applyRotation();
  }

  attach(element: HTMLElement): void {
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      this.#dragging = true;
      this.#lastX = event.clientX;
      this.#lastY = event.clientY;
      element.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!this.#dragging) return;
      const speed = 0.0032;
      this.#targetYaw = clamp(
        this.#targetYaw - (event.clientX - this.#lastX) * speed,
        -LOOK_LIMITS.yaw,
        LOOK_LIMITS.yaw,
      );
      this.#targetPitch = clamp(
        this.#targetPitch - (event.clientY - this.#lastY) * speed,
        LOOK_LIMITS.pitchDown,
        LOOK_LIMITS.pitchUp,
      );
      this.#lastX = event.clientX;
      this.#lastY = event.clientY;
    };
    const up = (event: PointerEvent) => {
      this.#dragging = false;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    };

    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.style.touchAction = 'none';

    this.#detach = () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
    };
  }

  detach(): void {
    this.#detach?.();
    this.#detach = null;
  }

  /** Eases toward where the player is looking, so the head has some weight. */
  update(delta: number): void {
    const ease = 1 - Math.exp(-14 * delta);
    this.#yaw += (this.#targetYaw - this.#yaw) * ease;
    this.#pitch += (this.#targetPitch - this.#pitch) * ease;
    this.#applyRotation();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
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
